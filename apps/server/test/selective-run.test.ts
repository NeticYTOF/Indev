import { describe, expect, it, vi } from 'vitest';
import { resolveVehicle, StatiqRunFatalError } from '@indeev/core';
import { runSelective } from '../src/selective-run.js';
import { endpointRouter } from '../../../packages/core/test/support/road-fixture.js';

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
      router: endpointRouter() as never,
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
      router: endpointRouter() as never,
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
      router: endpointRouter() as never,
      statiq,
      origin: { label: 'A', lat: 0, lon: 0 }, destination: { label: 'B', lat: 2.56, lon: 0 },
      via: [], resolved: resolveVehicle(), planOptions: {},
      budget: { deadlineMs: 600_000, maxUpstreamCalls: 100 },
    })).rejects.toMatchObject({ name: 'SelectiveRunError' });
    expect(calls).toBe(5);
  });
});

describe('final-answer host contract', () => {
  const call = { id: 'c', type: 'function',
    function: { name: 'get_station_details', arguments: '{"ids":[42]}' } } as const;
  const toolReply = { content: null, toolCalls: [call] };
  const finalReply = (ids: number[]) => ({
    content: JSON.stringify({ chosenStationIds: ids, notes: '' }), toolCalls: [],
  });
  const makeDeps = (distanceKm: number, stationCount: number, aiToolCall: never) => ({
    ai: { baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm' },
    aiToolCall,
    router: endpointRouter() as never,
    statiq: {
      markers: async () => ({ ok: true, live: true, retained: false, source: 'test',
        count: stationCount, stations: stationCount > 0 ? [{
          stationId: 42, name: station.name, lat: station.lat, lon: 0,
          address: null, accessType: 1, isCommunityListed: false, stationUrl: '',
        }] : [] }),
      detailsWithMeta: async () => ({ response: { ok: true, live: true,
        retained: false, source: 'test', station }, fetchedAt: new Date() }),
    } as never,
    origin: { label: 'A', lat: 0, lon: 0 },
    destination: { label: 'B', lat: distanceKm / 111.32, lon: 0 },
    via: [], resolved: resolveVehicle(), planOptions: distanceKm > 100 ? { startSocPct: 50 } : {},
    budget: { deadlineMs: 600_000, maxUpstreamCalls: 100 },
  });

  it('recovers from bad JSON to tool call and a validated final answer', async () => {
    let n = 0;
    const replies = [
      { content: '{not json', toolCalls: [] },
      toolReply,
      finalReply([42]),
    ];
    const result = await runSelective(makeDeps(285, 1, (async () => replies[n++]) as never));
    expect(n).toBe(3);
    expect(result.plan.stops.map((s) => s.station.stationId)).toEqual([42]);
    expect(result.diagnostics.detailChecksStarted).toBe(1);
    expect(result.diagnostics.finalAnswerEvents).toEqual([
      { reason: 'invalid_final_json', contentType: 'string', contentLength: 9 },
    ]);
  });

  it('recovers from wrong shape to a valid zero-stop answer', async () => {
    let n = 0;
    const replies = [
      { content: '{"chosenStationIds":"42"}', toolCalls: [] },
      finalReply([]),
    ];
    const result = await runSelective(makeDeps(20, 0, (async () => replies[n++]) as never));
    expect(n).toBe(2);
    expect(result.plan.stops).toHaveLength(0);
    expect(result.diagnostics.finalAnswerEvents?.[0]?.reason).toBe('invalid_final_shape');
  });

  it('keeps repeated invalid answers bounded', async () => {
    let n = 0;
    const err = await runSelective(makeDeps(20, 0, (async () => {
      n += 1;
      return { content: '{not json', toolCalls: [] };
    }) as never)).catch((e: unknown) => e);
    expect(n).toBe(4);
    expect(err).toMatchObject({ name: 'SelectiveRunError' });
    expect((err as { diagnostics: { finalAnswerEvents: unknown[] } }).diagnostics.finalAnswerEvents)
      .toHaveLength(4);
  });

  it('accepts a first-turn zero-stop answer on a reachable route', async () => {
    let n = 0;
    const result = await runSelective(makeDeps(20, 0, (async () => {
      n += 1;
      return finalReply([]);
    }) as never));
    expect(n).toBe(1);
    expect(result.plan.stops).toHaveLength(0);
    expect(result.diagnostics.finalAnswerEvents).toHaveLength(0);
  });

  it('rejects unknown IDs without treating valid JSON as a contract violation', async () => {
    let n = 0;
    const replies = [finalReply([999999]), toolReply, finalReply([42])];
    const result = await runSelective(makeDeps(285, 1, (async () => replies[n++]) as never));
    expect(n).toBe(3);
    expect(result.plan.stops.map((s) => s.station.stationId)).toEqual([42]);
    expect(result.diagnostics.finalAnswerEvents).toHaveLength(0);
  });

  it('hard-rejects finish_reason length before contract handling', async () => {
    let calls = 0;
    const aiFetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{
        message: { content: '{"chosenStationIds":[]}' }, finish_reason: 'length',
      }] }), { status: 200 });
    }) as typeof fetch;
    const deps = makeDeps(20, 0, undefined as never);
    const err = await runSelective({ ...deps, aiToolCall: undefined,
      ai: { ...deps.ai, fetchImpl: aiFetch } }).catch((e: unknown) => e) as Error & {
        cause?: { reason?: string }; diagnostics: { finalAnswerEvents: unknown[] };
      };
    expect(calls).toBe(1);
    expect(err.name).toBe('SelectiveRunError');
    expect(err.cause?.reason).toBe('output_limit');
    expect(err.diagnostics.finalAnswerEvents).toHaveLength(0);
  });
  it('keeps every candidate visible while adding advisory reachability only', async () => {
    let firstMessages: Array<{ role: string; content: string | null }> = [];
    const aiToolCall = (async (messages: Array<{ role: string; content: string | null }>) => {
      if (firstMessages.length === 0) firstMessages = messages;
      throw new Error('stop after prompt capture');
    }) as never;
    const base = makeDeps(285, 1, aiToolCall);
    const deps = { ...base, statiq: {
      markers: async () => ({ ok: true, live: true, retained: false, source: 'test', count: 3,
        stations: [0.2, 1.2, 2.4].map((lat, i) => ({
          stationId: 42 + i, name: `Station ${i}`, lat, lon: 0,
          address: null, accessType: 1, isCommunityListed: false, stationUrl: '',
        })) }),
      detailsWithMeta: async () => ({ response: { ok: true, live: true,
        retained: false, source: 'test', station }, fetchedAt: new Date() }),
    } as never };
    await runSelective(deps).catch(() => undefined);
    const user = JSON.parse(String(firstMessages[1]?.content)) as {
      candidates: { rows: Array<[number, ...unknown[]]> };
      reachability: { advisoryOnly: boolean; caveat: string };
    };
    expect(user.candidates.rows.map((row) => row[0])).toEqual([42, 43, 44]);
    expect(user.candidates.rows.every((row) => row.length === 7)).toBe(true);
    expect(user.reachability.advisoryOnly).toBe(true);
    expect(user.reachability.caveat).toMatch(/not proof/i);
    expect(JSON.stringify(user.reachability)).not.toMatch(/occupied|working-free|available|status/i);
  });

  it('projects power-only facts for rejected details without extra fetches', async () => {
    let n = 0;
    let toolMessages: Array<{ role: string; content: string | null }> = [];
    const spec = station.chargers[0]!;
    const detail = vi.fn(async () => ({
      response: { ok: true, live: true, retained: false, source: 'test',
        station: { ...station, chargers: [
          { ...spec, chargerId: 420, kw: 120,
            connectors: spec.connectors.map((plug) => ({ ...plug, status: 'faulted',
              available: false, note: 'UNIQUE_PRIVATE_SENTINEL' })) },
          { ...spec, chargerId: 421, kw: 30,
            connectors: spec.connectors.map((plug) => ({ ...plug, status: 'faulted',
              available: false, note: 'UNIQUE_PRIVATE_SENTINEL' })) },
        ] } },
      fetchedAt: new Date(),
    }));
    const deps = {
      ai: { baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm' },
      aiToolCall: async (messages: Array<{ role: string; content: string | null }>) => {
        n += 1;
        if (n === 1) return { content: null, toolCalls: [
          { id: 'c1', type: 'function',
            function: { name: 'get_station_details', arguments: '{"ids":[42]}' } },
        ] };
        toolMessages = messages;
        throw new Error('stop after rejected fact capture');
      },
      router: endpointRouter() as never,
      statiq: {
        markers: async () => ({ ok: true, live: true, retained: false, source: 'test', count: 1,
          stations: [{ stationId: 42, name: station.name, lat: 1.347, lon: 0,
            address: null, accessType: 1, isCommunityListed: false, stationUrl: '' }] }),
        detailsWithMeta: detail,
      } as never,
      origin: { label: 'A', lat: 0, lon: 0 },
      destination: { label: 'B', lat: 2.56, lon: 0 },
      via: [], resolved: resolveVehicle(),
      planOptions: { startSocPct: 50, maxChargerKw: 60 },
      budget: { deadlineMs: 600_000, maxUpstreamCalls: 100 },
    };
    await runSelective(deps as never).catch(() => undefined);
    expect(detail).toHaveBeenCalledTimes(1);
    expect(n).toBe(2);
    const tool = JSON.parse(String(toolMessages.at(-1)?.content)) as {
      facts: Array<{ stationId: number; unknown?: string; observedPower?: Record<string, unknown> }>;
    };
    expect(tool.facts).toEqual([{ stationId: 42, unknown: 'not certified',
      observedPower: { capKw: 60, withinCapChargerCount: 1,
        overCapChargerCount: 1, unknownCapChargerCount: 0, category: 'some-within',
        advisoryOnly: true,
        note: 'Observed power only; not eligibility or certification.' },
    }]);
    const toolText = toolMessages.filter((m) => m.role === 'tool')
      .map((m) => m.content ?? '').join('\n');
    expect(toolText).not.toMatch(/UNIQUE_PRIVATE_SENTINEL|health|status|available|occupied|charging|address|connector/i);
  });



describe('typed no-fit final contract', () => {
  const overcapDeps = (aiToolCall: never) => {
    const base = makeDeps(285, 1, aiToolCall);
    return { ...base,
      planOptions: { startSocPct: 50, maxChargerKw: 60 },
      statiq: {
        markers: async () => ({ ok: true, live: true, retained: false, source: 'test', count: 1,
          stations: [{ stationId: 42, name: station.name, lat: 1.347, lon: 0,
            address: null, accessType: 1, isCommunityListed: false, stationUrl: '' }] }),
        detailsWithMeta: async () => ({ response: { ok: true, live: true, retained: false,
          source: 'test', station: { ...station, chargers: [{ ...station.chargers[0], kw: 120 }] } },
          fetchedAt: new Date() }),
      } as never };
  };
  const noFit = JSON.stringify({ chosenStationIds: [], notes: '', status: 'not_determined' });

  it('terminates honestly after a checked over-cap station', async () => {
    let n = 0;
    const replies = [
      { content: null, toolCalls: [{ id: 'c1', type: 'function',
        function: { name: 'get_station_details', arguments: '{"ids":[42]}' } }] },
      { content: noFit, toolCalls: [] },
    ];
    const err = await runSelective(overcapDeps((async () => replies[n++]) as never)).catch((e: unknown) => e) as Error & {
      diagnostics: { noFitDeclared: boolean; finalAnswerEvents: unknown[];
        coverage: { normalTurns: number; finalTurns: number; unusedUniqueIds: number };
        toolAdmission: { attemptedCalls: number; admittedCalls: number } };
    };
    expect(n).toBe(2);
    expect(err.name).toBe('SelectiveRunError');
    expect(err.message).toMatch(/not determined/i);
    expect(err.message).toMatch(/not a verdict that the route is impossible/i);
    expect(err.diagnostics.noFitDeclared).toBe(true);
    expect(err.diagnostics.finalAnswerEvents).toHaveLength(0);
    expect(err.diagnostics.coverage).toMatchObject({ normalTurns: 2, finalTurns: 0, unusedUniqueIds: 19 });
    expect(err.diagnostics.toolAdmission).toMatchObject({ attemptedCalls: 1, admittedCalls: 1 });
  });

  it('keeps a format error separately diagnosed from the no-fit terminal reason', async () => {
    let n = 0;
    const replies = [
      { content: null, toolCalls: [{ id: 'c1', type: 'function',
        function: { name: 'get_station_details', arguments: '{"ids":[42]}' } }] },
      { content: '{bad json', toolCalls: [] },
      { content: noFit, toolCalls: [] },
    ];
    const err = await runSelective(overcapDeps((async () => replies[n++]) as never)).catch((e: unknown) => e) as Error & {
      diagnostics: { noFitDeclared: boolean; finalAnswerEvents: Array<{ reason: string }> };
    };
    expect(n).toBe(3);
    expect(err.message).toMatch(/not determined/i);
    expect(err.diagnostics.noFitDeclared).toBe(true);
    expect(err.diagnostics.finalAnswerEvents.map((e) => e.reason)).toContain('invalid_final_json');
  });

  it('does not accept premature no-fit while unchecked IDs and budget remain', async () => {
    let n = 0;
    const replies = [
      { content: noFit, toolCalls: [] },
      { content: null, toolCalls: [{ id: 'c2', type: 'function',
        function: { name: 'get_station_details', arguments: '{"ids":[42]}' } }] },
      { content: '{"chosenStationIds":[42]}', toolCalls: [] },
    ];
    const result = await runSelective(makeDeps(285, 1, (async () => replies[n++]) as never));
    expect(n).toBe(3);
    expect(result.plan.stops.map((s) => s.station.stationId)).toEqual([42]);
    expect(result.diagnostics.finalAnswerEvents.map((e) => e.reason)).toContain('premature_no_fit');
    expect(result.diagnostics.noFitDeclared).toBe(false);
  });

  it('rejects no-fit mixed with station IDs as an invalid shape', async () => {
    let n = 0;
    const bad = JSON.stringify({ chosenStationIds: [42], status: 'not_determined', notes: '' });
    const replies = [
      { content: bad, toolCalls: [] },
      { content: null, toolCalls: [{ id: 'c5', type: 'function',
        function: { name: 'get_station_details', arguments: '{"ids":[42]}' } }] },
      { content: '{"chosenStationIds":[42]}', toolCalls: [] },
    ];
    const result = await runSelective(makeDeps(285, 1, (async () => replies[n++]) as never));
    expect(n).toBe(3);
    expect(result.plan.stops.map((s) => s.station.stationId)).toEqual([42]);
    expect(result.diagnostics.finalAnswerEvents.map((e) => e.reason)).toContain('invalid_final_shape');
    expect(result.diagnostics.noFitDeclared).toBe(false);
  });

  it('rejects no-fit when host physics already permits zero stops', async () => {
    let n = 0;
    const replies = [
      { content: noFit, toolCalls: [] },
      { content: '{"chosenStationIds":[]}', toolCalls: [] },
    ];
    const result = await runSelective(makeDeps(20, 0, (async () => replies[n++]) as never));
    expect(n).toBe(2);
    expect(result.plan.stops).toHaveLength(0);
    expect(result.diagnostics.finalAnswerEvents.map((e) => e.reason)).toContain('premature_no_fit');
    expect(result.diagnostics.noFitDeclared).toBe(false);
  });
});
describe('progressive40 detail coverage', () => {
  const lats = Array.from({ length: 40 }, (_, i) => 0.18 + i * 0.45);
  const markerStations = lats.map((lat, i) => ({
    stationId: i + 1, name: `Station ${i + 1}`, lat, lon: 0,
    address: null, accessType: 1, isCommunityListed: false, stationUrl: '',
  }));
  const detailFor = (id: number) => ({
    response: { ok: true, live: true, retained: false, source: 'test',
      station: { ...station, stationId: id, lat: lats[id - 1]!, chargers: station.chargers.map((c) => ({ ...c })) } },
    fetchedAt: new Date(),
  });

  it('fetchs 40 distinct IDs, never a 41st, and stops after nine AI turns', async () => {
    let calls = 0;
    const detail = vi.fn(async (id: number) => detailFor(id));
    const base = makeDeps(2000, 1, (async () => {
      calls += 1;
      if (calls <= 8) {
        const first = (calls - 1) * 5 + 1;
        return { content: null, toolCalls: [{ id: `t${calls}`, type: 'function',
          function: { name: 'get_station_details',
            arguments: JSON.stringify({ ids: Array.from({ length: 5 }, (_, i) => first + i) }) } }] };
      }
      return { content: '{"chosenStationIds":[]}', toolCalls: [] };
    }) as never);
    const err = await runSelective({ ...base, coverageProfile: 'progressive40', statiq: {
      markers: async () => ({ ok: true, live: true, retained: false, source: 'test',
        count: 40, stations: markerStations }),
      detailsWithMeta: detail,
    } as never }).catch((e: unknown) => e) as Error & {
      diagnostics: {
        stationEvidence: { total: number; sampled: number; omitted: number; sampleLimit: number };
        matchedRuleCounts: Record<string, number>;
      };
    };
    expect(calls).toBe(9);
    expect(detail).toHaveBeenCalledTimes(40);
    expect(detail.mock.calls.every((args) => Number(args[0]) >= 1 && Number(args[0]) <= 40)).toBe(true);
    expect(err.name).toBe('SelectiveRunError');
    expect(err.diagnostics.stationEvidence).toEqual({
      total: 40, sampled: 20, omitted: 20, sampleLimit: 20,
    });
    expect(err.diagnostics.matchedRuleCounts.certified).toBe(40);
  });

  it('returns early on a valid first-turn zero-stop answer under progressive40', async () => {
    let calls = 0;
    const result = await runSelective({ ...makeDeps(20, 0, (async () => {
      calls += 1;
      return { content: '{"chosenStationIds":[]}', toolCalls: [] };
    }) as never), coverageProfile: 'progressive40' });
    expect(calls).toBe(1);
    expect(result.plan.stops).toHaveLength(0);
  });

  it('stops without correction when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const err = await runSelective({ ...makeDeps(285, 1, (async () => {
      calls += 1;
      return { content: '{"chosenStationIds":[]}', toolCalls: [] };
    }) as never), signal: controller.signal }).catch((e: unknown) => e);
    expect(calls).toBe(0);
    expect(err).toMatchObject({ name: 'SelectiveRunError' });
  });

  it('does not issue another AI turn after a fatal detail error', async () => {
    let calls = 0;
    const base = makeDeps(285, 1, (async () => {
      calls += 1;
      return { content: null, toolCalls: [{ id: 'c1', type: 'function',
        function: { name: 'get_station_details', arguments: '{"ids":[42]}' } }] };
    }) as never);
    const err = await runSelective({ ...base, statiq: {
      markers: async () => ({ ok: true, live: true, retained: false, source: 'test', count: 1,
        stations: [{ stationId: 42, name: station.name, lat: 1.347, lon: 0,
          address: null, accessType: 1, isCommunityListed: false, stationUrl: '' }] }),
      detailsWithMeta: async () => { throw new StatiqRunFatalError('auth', 403, '/stations/details', ''); },
    } as never }).catch((e: unknown) => e) as Error & { cause?: Error };
    expect(calls).toBe(1);
    expect(err.name).toBe('SelectiveRunError');
    expect(err.cause?.name).toBe('StatiqRunFatalError');
  });
});
});

describe('original reserve and target AI limits', () => {
  it('exposes resolved reserve and charge-to limits to AI and advisory guidance', async () => {
    let captured: Array<{ role: string; content: string | null }> = [];
    const aiFetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string | null }> };
      captured = body.messages;
      return new Response(JSON.stringify({ choices: [{ message: {
        content: '{"chosenStationIds":[]}',
      } }] }), { status: 200 });
    }) as typeof fetch;
    await runSelective({
      ai: { baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm', fetchImpl: aiFetch },
      router: endpointRouter() as never,
      statiq: { markers: async () => ({ ok: true, live: true, retained: false,
        source: 'test', count: 0, stations: [] }) } as never,
      origin: { label: 'A', lat: 0, lon: 0 },
      destination: { label: 'B', lat: 0.899, lon: 0 },
      via: [], resolved: resolveVehicle(),
      planOptions: { startSocPct: 50, reservePct: 12, targetSoc: 60 },
      budget: { deadlineMs: 600_000, maxUpstreamCalls: 100 },
    });
    const user = JSON.parse(String(captured[1]?.content)) as {
      limits: Record<string, number>;
      reachability: { initialReachKm: number };
    };
    expect(user.limits).toMatchObject({
      startSocPct: 50, reservePct: 12, targetSoc: 60,
      minArrivalSocPct: 12, absoluteMaxSocPct: 60,
    });
    expect(user.reachability.initialReachKm).toBeCloseTo(154.7, 1);
  });
});
