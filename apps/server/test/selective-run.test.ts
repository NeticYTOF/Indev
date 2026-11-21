import { describe, expect, it, vi } from 'vitest';
import { resolveVehicle } from '@indeev/core';
import { runSelective } from '../src/selective-run.js';

const station = {
  stationId: 42, name: 'Statiq Select', lat: 1.347, lon: 0,
  address: null, area: null, city: null, landmark: null,
  hours: '00:00 To 23:59', openText: 'Open Now', rating: 4, reviewCount: 10,
  accessType: 'public', navUrl: '', stationUrl: '', imageUrl: null,
  amenities: [], stepsToReach: null,
  chargers: [{
    chargerId: 420, name: '60 kW DC', type: 'DC', kw: 60, pricePerKwh: 20,
    currency: 'INR', lastUsedOn: null,
    connectors: [{
      displayId: 1, connectorId: 421, type: 'CCS-2',
      status: 'available', available: true, note: null,
    }],
  }],
  summary: { anyDc: true, ccs2Dc: true, maxDcCcs2Kw: 60, availableNow: true, statusCounts: null },
};

describe('AI-first selective run', () => {
  it('fetches details only for tool-selected on-route IDs', async () => {
    const detail = vi.fn(async () => ({
      response: { ok: true, live: true, retained: false, source: 'test', station },
      fetchedAt: new Date('2026-11-21T12:00:00Z'),
    }));
    const statiq = {
      markers: async () => ({
        ok: true, live: true, retained: false, source: 'test', count: 1,
        stations: [{
          stationId: 42, name: station.name, lat: station.lat, lon: 0,
          address: null, accessType: 1, isCommunityListed: false, stationUrl: '',
        }],
      }),
      detailsWithMeta: detail,
    } as never;
    const toolReply = {
      choices: [{ message: {
        content: null,
        tool_calls: [{
          id: 'c1', type: 'function',
          function: { name: 'get_station_details', arguments: '{"ids":[42]}' },
        }],
      } }],
    };
    const finalReply = {
      choices: [{ message: {
        content: JSON.stringify({ chosenStationIds: [42], notes: 'one safe stop' }),
      } }],
    };
    const aiFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string }> };
      const finalTurn = body.messages[body.messages.length - 1]?.role === 'tool';
      return new Response(JSON.stringify(finalTurn ? finalReply : toolReply), { status: 200 });
    }) as typeof fetch;
    const stages: string[] = [];
    const result = await runSelective({
      ai: { baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm', fetchImpl: aiFetch },
      router: {
        route: async () => ({
          distanceKm: 285, durationMin: 285,
          geometry: [{ lat: 0, lon: 0 }, { lat: 2.56, lon: 0 }],
        }),
      } as never,
      statiq,
      origin: { label: 'A', lat: 0, lon: 0 },
      destination: { label: 'B', lat: 2.56, lon: 0 },
      via: [],
      resolved: resolveVehicle(),
      planOptions: {},
      budget: { deadlineMs: 600_000, maxUpstreamCalls: 100 },
      onStage: (s) => { stages.push(s); },
    });
    expect(result.plan.stops.map((s) => s.station.stationId)).toEqual([42]);
    expect(result.plan.totals.totalTimeMin).toBeGreaterThan(0);
    expect(Number.isFinite(result.plan.totals.finalSocPct)).toBe(true);
    expect(detail).toHaveBeenCalledTimes(1);
    expect(stages).toContain('discovery');
    expect(stages).toContain('details');
    expect(stages).toContain('finalize');
    const sent = aiFetch.mock.calls.map((call) => String(call[1]?.body ?? '')).join('\n');
    expect(sent).not.toMatch(/occupied|working-free|working-occupied|faulted|offline|statusCounts|health/i);
  });

  it('reserves one bounded no-tools final turn after four tool rounds', async () => {
    const detail = vi.fn(async () => ({
      response: { ok: true, live: true, retained: false, source: 'test', station },
      fetchedAt: new Date('2026-11-21T12:00:00Z'),
    }));
    const statiq = {
      markers: async () => ({ ok: true, live: true, retained: false, source: 'test', count: 1,
        stations: [{ stationId: 42, name: station.name, lat: station.lat, lon: 0,
          address: null, accessType: 1, isCommunityListed: false, stationUrl: '' }] }),
      detailsWithMeta: detail,
    } as never;
    const toolReply = { choices: [{ message: { content: null, tool_calls: [{
      id: 'c', type: 'function', function: { name: 'get_station_details', arguments: '{"ids":[42]}' },
    }] } }] };
    const finalReply = { choices: [{ message: {
      content: JSON.stringify({ chosenStationIds: [42] }),
    } }] };
    let n = 0;
    const aiFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      n += 1;
      return new Response(JSON.stringify(n <= 4 ? toolReply : finalReply), { status: 200 });
    }) as typeof fetch;
    const result = await runSelective({
      ai: { baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm', fetchImpl: aiFetch },
      router: { route: async () => ({ distanceKm: 285, durationMin: 285,
        geometry: [{ lat: 0, lon: 0 }, { lat: 2.56, lon: 0 }] }) } as never,
      statiq,
      origin: { label: 'A', lat: 0, lon: 0 }, destination: { label: 'B', lat: 2.56, lon: 0 },
      via: [], resolved: resolveVehicle(), planOptions: {},
      budget: { deadlineMs: 600_000, maxUpstreamCalls: 100 },
    });
    expect(n).toBe(5);
    expect(detail).toHaveBeenCalledTimes(1);
    expect(result.diagnostics.detailChecksStarted).toBe(1);
    expect(result.diagnostics.detailChecksSettled).toBe(1);
    expect(result.diagnostics.candidatesProcessed).toBe(1);
    const bodies = aiFetch.mock.calls.map((c) => JSON.parse(String(c[1]?.body)) as {
      tools?: Array<{ function: { parameters: { properties: { ids: { minItems: number; maxItems: number } } } } }>;
      tool_choice?: string;
    });
    expect(bodies[0]?.tools?.[0]?.function?.parameters?.properties?.ids).toMatchObject({ minItems: 1, maxItems: 5 });
    expect(bodies[4]?.tool_choice).toBe('none');
    expect(bodies[4]?.tools).toBeUndefined();
  });

  it('stops a tool-only injected model after the reserved final turn', async () => {
    let calls = 0;
    const aiToolCall = async () => {
      calls += 1;
      if (calls > 5) throw new Error('runaway model loop');
      return { content: null, toolCalls: [{ id: `c${calls}`, type: 'function',
        function: { name: 'get_station_details', arguments: '{"ids":[42]}' } }] };
    };
    const statiq = {
      markers: async () => ({ ok: true, live: true, retained: false, source: 'test', count: 1,
        stations: [{ stationId: 42, name: station.name, lat: station.lat, lon: 0,
          address: null, accessType: 1, isCommunityListed: false, stationUrl: '' }] }),
      detailsWithMeta: async () => ({ response: { ok: true, live: true, retained: false,
        source: 'test', station }, fetchedAt: new Date() }),
    } as never;
    await expect(runSelective({
      ai: { baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm' },
      aiToolCall,
      router: { route: async () => ({ distanceKm: 285, durationMin: 285,
        geometry: [{ lat: 0, lon: 0 }, { lat: 2.56, lon: 0 }] }) } as never,
      statiq,
      origin: { label: 'A', lat: 0, lon: 0 }, destination: { label: 'B', lat: 2.56, lon: 0 },
      via: [], resolved: resolveVehicle(), planOptions: {},
      budget: { deadlineMs: 600_000, maxUpstreamCalls: 100 },
    })).rejects.toMatchObject({ name: 'SelectiveRunError' });
    expect(calls).toBe(5);
  });
});
