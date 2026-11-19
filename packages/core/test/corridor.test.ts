import { describe, expect, it } from 'vitest';
import { scanCorridor } from '../src/corridor.js';
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
