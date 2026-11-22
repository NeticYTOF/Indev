import { describe, expect, it, vi } from 'vitest';
import { resolveVehicle } from '@indeev/core';
import { runSelective } from '../src/selective-run.js';
import { endpointRouter } from '../../../packages/core/test/support/road-fixture.js';

const ids = Array.from({ length: 9 }, (_, i) => 1000 + i);
const latOf = (id: number) => id < 1006 ? 0.2 + (id - 1000) * 0.1 : 0.9 + (id - 1006) * 0.1;

function station(id: number) {
  const kw = id < 1005 ? 120 : 60;
  return {
    stationId: id, name: `Station ${id}`, lat: latOf(id), lon: 0,
    address: null, area: null, city: null, landmark: null, hours: null,
    openText: null, rating: null, reviewCount: null, accessType: 'public',
    navUrl: '', stationUrl: '', imageUrl: null, amenities: [], stepsToReach: null,
    chargers: [{
      chargerId: id * 10, name: `${kw} kW DC`, type: 'DC', kw, pricePerKwh: 20,
      currency: 'INR', lastUsedOn: null,
      connectors: [{
        displayId: 1, connectorId: id * 100, type: 'CCS-2',
        status: 'available', available: true, note: null,
      }],
    }],
    summary: { anyDc: true, ccs2Dc: true, maxDcCcs2Kw: kw,
      availableNow: true, statusCounts: null },
  };
}

describe('adaptive bounded shortlist', () => {
  it('continues past an unsuitable first batch without refetching memoized IDs', async () => {
    const detail = vi.fn(async (id: number) => ({
      response: { ok: true, live: true, retained: false, source: 'test', station: station(id) },
      fetchedAt: new Date('2026-11-21T12:00:00Z'),
    }));
    const statiq = {
      markers: async () => ({ ok: true, live: true, retained: false, source: 'test',
        count: ids.length,
        stations: ids.map((id) => ({ stationId: id, name: `Station ${id}`,
          lat: latOf(id), lon: 0, address: null, accessType: 1,
          isCommunityListed: false, stationUrl: '' })) }),
      detailsWithMeta: detail,
    } as never;
    const replies = [
      { choices: [{ message: { content: null, tool_calls: [{ id: 't1', type: 'function',
        function: { name: 'get_station_details', arguments: '{"ids":[1000,1001,1002,1003,1004]}' } }] } }] },
      { choices: [{ message: { content: null, tool_calls: [{ id: 't2', type: 'function',
        function: { name: 'get_station_details', arguments: '{"ids":[1000,1005,1006,1007,1008]}' } }] } }] },
      { choices: [{ message: { content: JSON.stringify({ chosenStationIds: [1006] }) } }] },
    ];
    let turn = 0;
    let progress: Record<string, unknown> | null = null;
    const aiFetch = (async (_url: unknown, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      const toolMessage = sent.messages.filter((m) => m.role === 'tool')[0];
      if (toolMessage && progress === null) {
        const answer = JSON.parse(toolMessage.content) as Record<string, unknown>;
        progress = (answer.planningProgress as Record<string, unknown>) ?? null;
      }
      return new Response(JSON.stringify(replies[turn++] ?? replies[2]!), { status: 200 });
    }) as typeof fetch;
    const result = await runSelective({
      ai: { baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm', fetchImpl: aiFetch },
      router: endpointRouter() as never,
      statiq,
      origin: { label: 'A', lat: 0, lon: 0 }, destination: { label: 'B', lat: 2.56, lon: 0 },
      via: [], resolved: resolveVehicle(),
      planOptions: { maxChargerKw: 60, startSocPct: 50 },
      budget: { deadlineMs: 600_000, maxUpstreamCalls: 100 },
    });
    expect(result.plan.stops.map((s) => s.station.stationId)).toEqual([1006]);
    expect(detail).toHaveBeenCalledTimes(9);
    expect(progress).toMatchObject({
      examinedDistinctIds: 5, remainingUniqueChecks: 15, remainingToolRounds: 3,
      certifiedStationIds: [], unexaminedCandidateCount: 4,
      nextAction: 'inspect_unchecked_candidates',
    });
    expect(JSON.stringify(progress)).not.toMatch(/occupied|health|fault|statusCounts/i);
    expect(turn).toBeLessThanOrEqual(5);
  });

  it('ends a fully examined one-candidate pool without requesting unchecked IDs', async () => {
    const detail = vi.fn(async () => ({
      response: { ok: true, live: true, retained: false, source: 'test', station: station(1000) },
      fetchedAt: new Date('2026-11-21T12:00:00Z'),
    }));
    const statiq = {
      markers: async () => ({ ok: true, live: true, retained: false, source: 'test', count: 1,
        stations: [{ stationId: 1000, name: 'Station 1000', lat: latOf(1000), lon: 0,
          address: null, accessType: 1, isCommunityListed: false, stationUrl: '' }] }),
      detailsWithMeta: detail,
    } as never;
    let turn = 0;
    let exhaustedProgress: Record<string, unknown> | null = null;
    const aiFetch = (async (_url: unknown, init?: RequestInit) => {
      turn += 1;
      const sent = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      const toolMessage = sent.messages.filter((m) => m.role === 'tool')[0];
      if (toolMessage && exhaustedProgress === null) {
        const answer = JSON.parse(toolMessage.content) as Record<string, unknown>;
        exhaustedProgress = (answer.planningProgress as Record<string, unknown>) ?? null;
      }
      const answer = turn === 1
        ? { choices: [{ message: { content: null, tool_calls: [{ id: 't1', type: 'function',
          function: { name: 'get_station_details', arguments: '{"ids":[1000]}' } }] } }] }
        : { choices: [{ message: { content: JSON.stringify({ chosenStationIds: [1000] }) } }] };
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as typeof fetch;
    const err = await runSelective({
      ai: { baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm', fetchImpl: aiFetch },
      router: endpointRouter() as never,
      statiq,
      origin: { label: 'A', lat: 0, lon: 0 }, destination: { label: 'B', lat: 2.56, lon: 0 },
      via: [], resolved: resolveVehicle(),
      planOptions: { maxChargerKw: 60, startSocPct: 50 },
      budget: { deadlineMs: 600_000, maxUpstreamCalls: 100 },
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'SelectiveRunError' });
    const message = (err as Error).message;
    expect(message).toContain('Bounded search ended');
    expect(message).toContain('1 detail checks started');
    expect(message).toContain('1 of 1 unique on-route candidates reserved');
    expect(message).toContain('not determined');
    expect(message).not.toMatch(/budget exhausted|infeasible/i);
    expect(detail).toHaveBeenCalledTimes(1);
    expect(exhaustedProgress).toMatchObject({
      examinedDistinctIds: 1,
      remainingUniqueChecks: 19,
      certifiedStationIds: [],
      unexaminedCandidateCount: 0,
    });
    expect(exhaustedProgress?.nextAction).toBe('choose_from_certified_or_report_not_determined');
  });
});
