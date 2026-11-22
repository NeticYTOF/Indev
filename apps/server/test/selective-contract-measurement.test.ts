import { describe, expect, it } from 'vitest';
import { resolveVehicle } from '@indeev/core';
import { runSelective, SelectiveRunError, type SelectiveRunResult } from '../src/selective-run.js';
import { endpointRouter } from '../../../packages/core/test/support/road-fixture.js';

interface Metric {
  turn: number;
  chars: number;
  bytes: number;
  priorListKeys: number;
  currentNewListKeys: number;
  reachabilityKeys: number;
  toolPriorListKeys: number;
  toolCurrentNewListKeys: number;
  toolReachabilityKeys: number;
}
const PRIOR = Array.from({ length: 33 }, (_, i) => 1000 + i);
const NEW = [2000, 2001, 2002, 2003];
const ALL = [...PRIOR, ...NEW];
const station = (stationId: number, index: number) => ({
  stationId, name: `SYNTHETIC ${stationId}`, lat: (10 + index * 7) / 111.32, lon: 0,
  address: null, area: null, city: null, landmark: null, hours: '00:00 To 23:59',
  openText: 'Open Now', rating: 4, reviewCount: 10, accessType: 'public',
  navUrl: '', stationUrl: '', imageUrl: null, amenities: [], stepsToReach: null,
  chargers: [{ chargerId: stationId * 10, name: 'SYNTHETIC 200 kW DC', type: 'DC',
    kw: 200, pricePerKwh: 20, currency: 'INR', lastUsedOn: null, connectors: [{
      displayId: 1, connectorId: stationId * 10 + 1, type: 'CCS-2', status: 'available',
      available: true, note: null }] }],
});
function hasDiagnostics(value: unknown): value is { diagnostics: SelectiveRunResult['diagnostics'] } {
  return value !== null && typeof value === 'object' && 'diagnostics' in value &&
    value.diagnostics !== null && typeof value.diagnostics === 'object';
}
function diagnosticsOf(value: unknown): SelectiveRunResult['diagnostics'] {
  if (hasDiagnostics(value)) return value.diagnostics;
  throw new Error('expected a completed selective run');
}
function countKey(value: unknown, key: string): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countKey(item, key), 0);
  if (value === null || typeof value !== 'object') return 0;
  let total = Object.prototype.hasOwnProperty.call(value, key) ? 1 : 0;
  for (const item of Object.values(value)) total += countKey(item, key);
  return total;
}
function decodedContents(messages: readonly unknown[], toolOnly = false): unknown[] {
  const contents: unknown[] = [];
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || !('content' in message) ||
        typeof message.content !== 'string') continue;
    if (toolOnly && !('role' in message && message.role === 'tool')) continue;
    try { contents.push(JSON.parse(message.content)); } catch { contents.push(null); }
  }
  return contents;
}

describe('offline serialized selective-contract measurement', () => {
  it('captures adapter-serialized requests with controlled historical deferrals', async () => {
    const metrics: Metric[] = [];
    let turn = 0;
    const detail = async (id: number) => ({ response: { ok: true, live: true, retained: false,
      source: 'synthetic-test', station: station(id, ALL.indexOf(id)) },
      fetchedAt: new Date('2026-11-22T12:00:00Z') });
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const parsed: unknown = JSON.parse(String(init?.body));
      const tools = parsed !== null && typeof parsed === 'object' && 'tools' in parsed
        ? parsed.tools : undefined;
      const messages = parsed !== null && typeof parsed === 'object' && 'messages' in parsed &&
        Array.isArray(parsed.messages) ? parsed.messages : [];
      const serialized = JSON.stringify(messages);
      turn += 1;
      const decoded = decodedContents(messages);
      const toolPayloads = decodedContents(messages, true);
      metrics.push({ turn, chars: serialized.length, bytes: Buffer.byteLength(serialized),
        priorListKeys: countKey(decoded, 'priorCheckedIds'),
        currentNewListKeys: countKey(decoded, 'currentNewCandidateIds'),
        reachabilityKeys: countKey(decoded, 'reachability'),
        toolPriorListKeys: countKey(toolPayloads, 'priorCheckedIds'),
        toolCurrentNewListKeys: countKey(toolPayloads, 'currentNewCandidateIds'),
        toolReachabilityKeys: countKey(toolPayloads, 'reachability') });
      if (!Array.isArray(tools) || tools.length === 0) {
        return new Response(JSON.stringify({ choices: [{ message: {
          content: JSON.stringify({ chosenStationIds: [], status: 'not_determined' }),
        } }] }), { status: 200 });
      }
      const ids = turn === 1 ? PRIOR.slice(0, 5) : NEW;
      return new Response(JSON.stringify({ choices: [{ message: { content: null,
        tool_calls: [{ id: `c${turn}`, type: 'function', function: { name: 'get_station_details',
          arguments: JSON.stringify({ ids }) } }] } }] }), { status: 200 });
    }) as typeof fetch;

    const outcome = await runSelective({
      ai: { baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm', fetchImpl },
      router: endpointRouter() as never,
      statiq: {
        markers: async () => ({ ok: true, live: true, retained: false, source: 'synthetic-test',
          count: ALL.length, stations: ALL.map((id, i) => ({ stationId: id,
            name: `SYNTHETIC ${id}`, lat: station(id, i).lat, lon: 0, address: null,
            accessType: 1, isCommunityListed: false, stationUrl: '' })) }),
        detailsWithMeta: detail,
      } as never,
      origin: { label: 'A', lat: 0, lon: 0 },
      destination: { label: 'B', lat: 300 / 111.32, lon: 0 }, via: [],
      resolved: resolveVehicle(), planOptions: { startSocPct: 50, maxChargerKw: 60 },
      budget: { deadlineMs: 600_000, maxUpstreamCalls: 200 },
      history: { available: true, priorCheckedIds: PRIOR },
    }).catch((e: unknown) => e);
    const d = outcome instanceof SelectiveRunError ? outcome.diagnostics : diagnosticsOf(outcome);
    console.log(JSON.stringify({ label: 'offline-serialized-contract',
      outcome: outcome instanceof SelectiveRunError ? 'not_determined' : 'completed',
      metrics, normalTurns: d.normalTurns, deferredIds: d.history.deferredIds,
      note: 'bytes are serialized messages-only JSON sizes, not tokenizer usage' }));
    expect(metrics[0]?.priorListKeys).toBe(1);
    expect(metrics[0]?.reachabilityKeys).toBeGreaterThan(0);
    expect(metrics.slice(1).every((m) => m.toolPriorListKeys === 0 &&
      m.toolCurrentNewListKeys === 0 && m.toolReachabilityKeys === 0)).toBe(true);
    expect(d.history.deferredIds).toBeGreaterThanOrEqual(5);
  });
});
