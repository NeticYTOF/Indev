import { describe, expect, it } from 'vitest';
import {
  scanCorridor,
  type CorridorScanProgress,
} from '../src/corridor.js';
import { UpstreamRunStoppedError } from '../src/upstream-budget.js';
import type { StatiqClient } from '../src/statiq.js';
import type { Coords } from '../src/geo.js';
import type { StatiqMarker, StatiqMarkersResponse } from '../src/types.js';

function marker(id: number, lat: number, lon: number): StatiqMarker {
  return {
    stationId: id,
    name: `Station ${id}`,
    lat,
    lon,
    address: null,
    accessType: 1,
    isCommunityListed: false,
    stationUrl: `https://statiq.in/${id}`,
  };
}

function markersResponse(stations: StatiqMarker[]): StatiqMarkersResponse {
  return { ok: true, live: true, retained: false, source: 'test', count: stations.length, stations };
}

/** Client fake that replays the same station list for every markers() call. */
function fakeClient(stations: StatiqMarker[]): { client: StatiqClient; calls: Coords[] } {
  const calls: Coords[] = [];
  const client = {
    markers: async (lat: number, lon: number) => {
      calls.push({ lat, lon });
      return markersResponse(stations);
    },
    // details interface isn't used by scanCorridor
    details: async (id: number) => ({ ok: true, station: { stationId: id, chargers: [] } }),
  } as unknown as StatiqClient;
  return { client, calls };
}

// straight-line route ~197 km east-to-west at lat 28
const route: Coords[] = [
  { lat: 28.0, lon: 78.0 },
  { lat: 28.0, lon: 76.0 },
];

describe('scanCorridor', () => {
  it('dedupes across overlapping samples and filters off-route stations', async () => {
    const near = marker(1, 28.005, 77.0); // ~0.55 km off the route
    const far = marker(2, 28.2, 77.0); // ~22 km off the route -> filtered
    const { client, calls } = fakeClient([near, far]);

    const res = await scanCorridor(client, route, { stepKm: 12 });
    expect(calls.length).toBeGreaterThanOrEqual(16); // 12 km step over ~197 km
    expect(res.stationsSeen).toBe(2); // both unique stations were seen
    expect(res.candidates).toHaveLength(1); // only the near one survives the filter
    expect(res.candidates[0]?.stationId).toBe(1);
    expect(res.candidates[0]?.offRouteKm).toBeGreaterThan(0.4);
    expect(res.candidates[0]?.offRouteKm).toBeLessThan(0.8);
    // mid-route on a ~197 km line
    expect(res.candidates[0]?.chainageKm).toBeCloseTo(98.6, 0);
  });

  it('returns empty for routes with no stations around', async () => {
    const { client, calls } = fakeClient([]);
    const res = await scanCorridor(client, route, { stepKm: 12 });
    expect(res.candidates).toEqual([]);
    expect(res.stationsSeen).toBe(0);
    expect(res.samples).toBe(calls.length);
  });

  it('handles degenerate routes without calling the API', async () => {
    const { client, calls } = fakeClient([]);
    const res = await scanCorridor(client, [{ lat: 1, lon: 1 }]);
    expect(res.candidates).toEqual([]);
    expect(res.samples).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe('incremental scan progress (onProgress)', () => {
  it('reports the plan first, then every completed sample, ending at the plan', async () => {
    const { client } = fakeClient([]);
    const events: CorridorScanProgress[] = [];
    const res = await scanCorridor(client, route, {
      stepKm: 12,
      onProgress: (p) => events.push({ ...p }),
    });
    const planned = res.samplesAttempted;
    expect(planned).toBeGreaterThanOrEqual(16); // ~197 km / 12 km step + dest
    // PLAN-FIRST: the first report carries the full plan, zero completed
    expect(events[0]).toEqual({ planned, attempted: 0, ok: 0, failed: 0 });
    // one report per completion, plus the plan-first report
    expect(events).toHaveLength(planned + 1);
    const last = events[events.length - 1] as CorridorScanProgress;
    expect(last).toEqual({ planned, attempted: planned, ok: planned, failed: 0 });
    // counters are monotonic and always internally consistent
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1] as CorridorScanProgress;
      const cur = events[i] as CorridorScanProgress;
      expect(cur.attempted).toBe(prev.attempted + 1);
      expect(cur.ok + cur.failed).toBe(cur.attempted);
      expect(cur.planned).toBe(planned);
    }
  });

  it('counts failed samples in the incremental progress', async () => {
    const failing = {
      markers: async (_lat: number, lon: number): Promise<StatiqMarkersResponse> => {
        // NOTE: this route runs along a constant latitude, so the sample
        // points are distinguished by LON; fail exactly the d=0 vertex
        // (lon 78.0) and let the rest succeed (empty responses).
        if (Math.abs(lon - 78.0) < 1e-9) {
          throw new Error('upstream unavailable at this sample');
        }
        return markersResponse([]);
      },
    } as unknown as StatiqClient;
    const events: CorridorScanProgress[] = [];
    await scanCorridor(failing, route, {
      stepKm: 12,
      onProgress: (p) => events.push({ ...p }),
    });
    const last = events[events.length - 1] as CorridorScanProgress;
    expect(last.ok + last.failed).toBe(last.attempted);
    expect(last.attempted).toBe(last.planned); // every sample completed
    expect(last.failed).toBe(1); // exactly the first sample failed
    expect(last.ok).toBe(last.planned - 1);
  });

  it('keeps progress made before a FATAL mid-scan unwind (concurrency 1)', async () => {
    // three samples succeed, the fourth throws a run-fatal stop: the scan
    // unwinds (fatal errors are rethrown, NEVER recorded as sample failures)
    // but every report before the fatal is already delivered
    let n = 0;
    const client = {
      markers: async (): Promise<StatiqMarkersResponse> => {
        n++;
        if (n > 3) throw new UpstreamRunStoppedError('throttled', 3, 100, 60_000);
        return markersResponse([]);
      },
    } as unknown as StatiqClient;
    const events: CorridorScanProgress[] = [];
    await expect(
      scanCorridor(client, route, {
        stepKm: 12,
        concurrency: 1,
        onProgress: (p) => events.push({ ...p }),
      }),
    ).rejects.toBeInstanceOf(UpstreamRunStoppedError);
    // plan-first + exactly the three successful completions survived
    expect(events).toHaveLength(4);
    expect(events[0]?.attempted).toBe(0);
    const last = events[events.length - 1] as CorridorScanProgress;
    expect(last).toEqual({ planned: last.planned, attempted: 3, ok: 3, failed: 0 });
    expect(last.planned).toBeGreaterThanOrEqual(16);
  });
});
