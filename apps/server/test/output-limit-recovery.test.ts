import { describe, expect, it, vi } from 'vitest';
import { resolveVehicle } from '@indeev/core';
import { AiProviderError } from '../src/ai-provider.js';
import { runSelective, SelectiveRunError, type SelectiveRunResult } from '../src/selective-run.js';
import { endpointRouter } from '../../../packages/core/test/support/road-fixture.js';

type ToolReply = { content: string | null; toolCalls: Array<{
  id: string; type: 'function'; function: { name: string; arguments: string };
}> };
type DetailFn = (...args: unknown[]) => Promise<{ response: unknown; fetchedAt: Date }>;
const origin = { label: 'A', lat: 0, lon: 0 };
const destination = { label: 'B', lat: 2.56, lon: 0 };
const station = { stationId: 42, name: 'SYNTHETIC 42', lat: 1.347, lon: 0, address: null,
  area: null, city: null, landmark: null, hours: '00:00 To 23:59', openText: 'Open Now',
  rating: 4, reviewCount: 10, accessType: 'public', navUrl: '', stationUrl: '',
  imageUrl: null, amenities: [], stepsToReach: null,
  chargers: [{ chargerId: 420, name: 'SYNTHETIC 60 kW DC', type: 'DC', kw: 60,
    pricePerKwh: 20, currency: 'INR', lastUsedOn: null, connectors: [{
      displayId: 1, connectorId: 421, type: 'CCS-2', status: 'available',
      available: true, note: null }] }] };
const fresh = { ok: true, live: true, retained: false, source: 'synthetic-test', station };
const toolReply = (id: number): ToolReply => ({ content: null, toolCalls: [{
  id: `c${id}`, type: 'function', function: { name: 'get_station_details',
    arguments: '{"ids":[42]}' },
}] });
const finalNoFit: ToolReply = { content: JSON.stringify({ chosenStationIds: [], status: 'not_determined' }),
  toolCalls: [] };
const finalChosen: ToolReply = { content: JSON.stringify({ chosenStationIds: [42] }), toolCalls: [] };
const limitError = (): AiProviderError => new AiProviderError('Synthetic output limit', 'output_limit');

function deps(aiToolCall: (...args: unknown[]) => Promise<ToolReply>, detail: DetailFn,
  signal?: AbortSignal) {
  return {
    ai: { baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm' },
    aiToolCall: aiToolCall as never,
    router: endpointRouter() as never,
    statiq: {
      markers: async () => ({ ok: true, live: true, retained: false, source: 'synthetic-test',
        count: 1, stations: [{ stationId: 42, name: station.name, lat: 1.347, lon: 0,
          address: null, accessType: 1, isCommunityListed: false, stationUrl: '' }] }),
      detailsWithMeta: detail,
    } as never,
    origin, destination, via: [], resolved: resolveVehicle(),
    planOptions: { startSocPct: 50, maxChargerKw: 60 },
    budget: { deadlineMs: 600_000, maxUpstreamCalls: 100 },
    ...(signal ? { signal } : {}),
  };
}
function diagOf(value: unknown): SelectiveRunResult['diagnostics'] {
  if (value instanceof SelectiveRunError) return value.diagnostics;
  throw new Error('expected SelectiveRunError');
}
function hasDiagnostics(value: unknown): value is { diagnostics: SelectiveRunResult['diagnostics'] } {
  return value !== null && typeof value === 'object' && 'diagnostics' in value &&
    value.diagnostics !== null && typeof value.diagnostics === 'object';
}
function okDiag(value: unknown): SelectiveRunResult['diagnostics'] {
  if (hasDiagnostics(value)) return value.diagnostics;
  throw new Error('expected successful run');
}

describe('bounded output_limit recovery', () => {
  it('accepts one real adapter cutoff then a complete valid flow', async () => {
    let turn = 0;
    const detail = vi.fn(async () => ({ response: fresh, fetchedAt: new Date() }));
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      turn += 1;
      const choice = turn === 1
        ? { message: { content: null }, finish_reason: 'length' }
        : turn === 3
          ? { message: finalChosen, finish_reason: 'stop' }
          : { message: { content: null, tool_calls: toolReply(turn).toolCalls },
            finish_reason: 'stop' };
      return new Response(JSON.stringify({ choices: [choice] }), { status: 200 });
    }) as typeof fetch;
    const base = deps(async () => { throw new Error('unused'); }, detail);
    const { aiToolCall: _unused, ...adapterDeps } = base;
    void _unused;
    const result = await runSelective({ ...adapterDeps,
      ai: { baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm', fetchImpl } });
    expect(okDiag(result)).toMatchObject({ modelOutputLimitCutoffs: 1,
      modelOutputLimitRecoveries: 1 });
    expect(result).toMatchObject({ plan: { stops: [{ station: { stationId: 42 } }] } });
    expect(detail).toHaveBeenCalledTimes(1);
    expect(turn).toBe(3);
  });

  it('stops after a second cutoff without another recovery', async () => {
    let call = 0;
    const detail = vi.fn(async () => ({ response: fresh, fetchedAt: new Date() }));
    const err = await runSelective(deps(async () => { call += 1; throw limitError(); }, detail))
      .catch((e: unknown) => e);
    expect(diagOf(err)).toMatchObject({ modelOutputLimitCutoffs: 2,
      modelOutputLimitRecoveries: 1 });
    expect(call).toBe(2);
    expect(detail).not.toHaveBeenCalled();
  });

  it('does not recover without another normal slot', async () => {
    let call = 0;
    const detail = vi.fn(async () => ({ response: fresh, fetchedAt: new Date() }));
    const err = await runSelective(deps(async () => {
      call += 1;
      if (call === 4) throw limitError();
      return toolReply(call);
    }, detail)).catch((e: unknown) => e);
    expect(call).toBe(4);
    expect(diagOf(err)).toMatchObject({ modelOutputLimitCutoffs: 1,
      modelOutputLimitRecoveries: 0 });
    expect(detail).toHaveBeenCalledTimes(1);
  });

  it('never converts a reserved final-turn cutoff into recovery', async () => {
    let call = 0;
    const detail = vi.fn(async () => ({ response: fresh, fetchedAt: new Date() }));
    const err = await runSelective(deps(async () => {
      call += 1;
      if (call === 5) throw limitError();
      return toolReply(call);
    }, detail)).catch((e: unknown) => e);
    const d = diagOf(err);
    expect(call).toBe(5);
    expect(d).toMatchObject({ modelOutputLimitCutoffs: 1, modelOutputLimitRecoveries: 0,
      finalTurns: 1 });
  });

  it('does not recover after cancellation between attempts', async () => {
    const controller = new AbortController();
    let call = 0;
    const err = await runSelective(deps(async () => {
      call += 1;
      controller.abort();
      throw limitError();
    }, vi.fn(async () => ({ response: fresh, fetchedAt: new Date() })), controller.signal)).catch((e: unknown) => e);
    expect(call).toBe(1);
    expect(diagOf(err)).toMatchObject({ modelOutputLimitCutoffs: 1,
      modelOutputLimitRecoveries: 0 });
  });

  it('does not recover on fatal non-output provider errors', async () => {
    let call = 0;
    const err = await runSelective(deps(async () => {
      call += 1;
      throw new AiProviderError('Synthetic auth failure', 'provider');
    }, vi.fn(async () => ({ response: fresh, fetchedAt: new Date() })))).catch((e: unknown) => e);
    expect(call).toBe(1);
    expect(diagOf(err)).toMatchObject({ modelOutputLimitCutoffs: 0,
      modelOutputLimitRecoveries: 0 });
  });

  it('stops immediately on malformed recovered output', async () => {
    let call = 0;
    const err = await runSelective(deps(async () => {
      call += 1;
      if (call === 1) throw limitError();
      return { content: 'NOT JSON', toolCalls: [] };
    }, vi.fn(async () => ({ response: fresh, fetchedAt: new Date() })))).catch((e: unknown) => e);
    expect(call).toBe(2);
    expect(diagOf(err)).toMatchObject({ modelOutputLimitCutoffs: 1,
      modelOutputLimitRecoveries: 1 });
  });
});
