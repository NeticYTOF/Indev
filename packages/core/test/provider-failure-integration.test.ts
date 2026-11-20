import { describe, expect, it } from 'vitest';
import { scanCorridor } from '../src/corridor.js';
import { createProviderFailureCollector } from '../src/provider-failure.js';
import { StatiqClient } from '../src/statiq.js';
import { UpstreamBudget } from '../src/upstream-budget.js';
import { cumulativeKm } from '../src/geo.js';
import type { Coords } from '../src/geo.js';
import type { StatiqMarkersResponse } from '../src/types.js';

const ROUTE: Coords[] = [];
for (let i = 0; i <= 24; i++) ROUTE.push({ lat: 28 + i * (12 / 111.32), lon: 77 });
const KM_PER_SAMPLE = 12;

function emptyMarkers(): StatiqMarkersResponse {
  return { ok: true, live: true, retained: false, source: 'fixture', count: 0, stations: [] };
}

describe('per-run provider evidence integration', () => {
  it('uses scan index for sample ordinal even when completion order is reversed', async () => {
    const observedOrdinals: Array<number | null | undefined> = [];
    let call = 0;
    const statiq = {
      markers: async (
        _lat: number,
        _lon: number,
        _signal?: AbortSignal,
        context?: { sampleOrdinal?: number | null },
      ): Promise<StatiqMarkersResponse> => {
        observedOrdinals.push(context?.sampleOrdinal);
        const current = call++;
        if (current === 0) await new Promise<void>((resolve) => setTimeout(resolve, 10));
        return emptyMarkers();
      },
    };
    await scanCorridor(statiq, ROUTE, { concurrency: 2 });
    const totalKm = cumulativeKm(ROUTE).at(-1) ?? 0;
    const expectedSamples = Math.ceil(totalKm / KM_PER_SAMPLE) + 1;
    expect(observedOrdinals.slice(0, 2)).toEqual([1, 2]);
    expect(observedOrdinals).toHaveLength(expectedSamples);
    expect(observedOrdinals.at(-1)).toBe(expectedSamples);
  });

  it('keeps simultaneous run collectors isolated', async () => {
    const first = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const second = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const clients = [first, second].map((collector) => {
      const client = new StatiqClient({
        token: 'fixture',
        fetchImpl: async () => new Response('bad', { status: 400 }),
        retries: 0,
        maxCallsPerMinute: 1_000_000,
        minCallGapMs: 0,
        sleepImpl: async () => {},
      });
      client.attachRunBudget(new UpstreamBudget(1), collector);
      return client;
    });
    const results = await Promise.allSettled(clients.map((client) => client.markers(0, 0)));
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(first.snapshot().failures).toHaveLength(1);
    expect(second.snapshot().failures).toHaveLength(1);
    expect(first.snapshot().failures[0]?.dispatchSeq).toBe(1);
    expect(second.snapshot().failures[0]?.dispatchSeq).toBe(1);
  });
});
