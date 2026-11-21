/**
 * Strict bulk transport: envelope cross-checks, pessimistic reservation and
 * settlement, per-item audit, unknown-state latch, exact empty proof, and real
 * corridor adoption. Offline only - fake transport, no provider calls.
 *
 * ALL response echoes are built from the CAPTURED request body squares/keys/
 * vertices and station ids - the client generates real per-point squares, so
 * static fixture coordinates would be correctly rejected by production echo
 * validation.
 */
import { describe, expect, it } from 'vitest';
import { StatiqAbortError, StatiqClient, type UpstreamAuditEntry } from '../src/statiq.js';
import { UpstreamBudget, UpstreamRunStoppedError } from '../src/upstream-budget.js';
import { scanCorridor, type BulkMarkerSource } from '../src/corridor.js';
import { createProviderFailureCollector, type ProviderFailureCollector } from '../src/provider-failure.js';

const NOW = '2026-11-21T10:00:00.000Z';
const LATER = '2026-11-21T10:00:01.000Z';

interface SquareEcho {
  key: string;
  latitude: number;
  longitude: number;
  vertices: number[][];
}
interface StationEcho {
  key: string;
  stationId: number;
}
type MarkerOutcome = 'ok' | 'confirmed-empty' | 'unknown' | 'not-attempted';
interface MarkerSpec {
  outcome?: MarkerOutcome;
  reason?: string;
  statuses?: (number | string)[];
  ids?: number[];
  message?: string;
}

function marker(id: number) {
  return { stationId: id, name: `Station ${id}`, lat: 28.6 + id / 1000, lon: 77.2 + id / 1000,
    address: null, accessType: 1, isCommunityListed: false, stationUrl: '' };
}

function echoed(square: SquareEcho) {
  return { key: square.key, latitude: square.latitude,
    longitude: square.longitude, vertices: square.vertices };
}

function markerItem(square: SquareEcho, spec: MarkerSpec = {}) {
  const outcome = spec.outcome ?? 'ok';
  const common = echoed(square);
  if (outcome === 'not-attempted') {
    return { ...common, outcome, reason: spec.reason ?? 'budget_exhausted',
      upstream: { attempts: 0, statuses: [], fetchedAt: null },
      provenance: null, data: null };
  }
  if (outcome === 'unknown') {
    return { ...common, outcome, reason: spec.reason ?? 'upstream_timeout',
      upstream: { attempts: 1, statuses: spec.statuses ?? ['timeout'], fetchedAt: LATER },
      provenance: null, data: null };
  }
  if (outcome === 'confirmed-empty') {
    return { ...common, outcome, reason: null,
      upstream: { attempts: 1, statuses: [200], fetchedAt: LATER },
      provenance: { sourceUrlPath: '/station/v1/markers', httpStatus: 200,
        contentType: 'application/json', cacheControl: null },
      data: null,
      confirmation: { sourceUrlPath: '/station/v1/markers', httpStatus: 200,
        contentType: 'application/json', cacheControl: null, fetchedAt: LATER,
        statusCode: 1001, success: false,
        message: spec.message ?? 'No stations found with selected filters', stationsCount: 0 } };
  }
  const stations = (spec.ids ?? [1]).map(marker);
  return { ...common, outcome: 'ok', reason: null,
    upstream: { attempts: 1, statuses: [200], fetchedAt: LATER },
    provenance: { sourceUrlPath: '/station/v1/markers', httpStatus: 200,
      contentType: 'application/json; charset=utf-8', cacheControl: null },
    data: { source: 'Statiq station markers (live)', count: stations.length, stations } };
}

function envelope(endpoint: 'markers-bulk' | 'details-bulk', items: any[], opts: {
  attempts?: number; histogram?: Record<string, number>;
  ok?: boolean; completed?: number; attempted?: number;
} = {}) {
  const attempts = opts.attempts ?? items.reduce((n, i: any) => n + i.upstream.attempts, 0);
  const completed = opts.completed ?? items.filter((i: any) =>
    i.outcome === 'ok' || i.outcome === 'confirmed-empty').length;
  const attempted = opts.attempted ?? items.filter((i: any) => i.upstream.attempts > 0).length;
  const derived: Record<string, number> = {};
  for (const item of items) {
    for (const status of item.upstream.statuses) {
      const key = String(status);
      derived[key] = (derived[key] ?? 0) + 1;
    }
  }
  return {
    ok: opts.ok ?? (completed === items.length),
    live: true, retained: false, endpoint,
    startedAt: NOW, completedAt: LATER,
    deadline: { ms: 150000, hit: false },
    requestedItems: items.length, attemptedItems: attempted, completedItems: completed,
    upstreamAttempts: attempts,
    upstreamByStatus: opts.histogram ?? derived,
    items,
  };
}

function markersResponse(body: any, specs: MarkerSpec[] = [], opts: Parameters<typeof envelope>[2] = {}) {
  const squares = (body.squares ?? []) as SquareEcho[];
  return envelope('markers-bulk', squares.map((sq, i) => markerItem(sq, specs[i])), opts);
}

function stationDetail(id: number, kw: unknown = 60, price: unknown = 20) {
  return { stationId: id, name: `S${id}`, lat: 28.6, lon: 77.2, address: null,
    chargers: [{ chargerId: 1, name: 'DC', type: 'DC', kw, pricePerKwh: price,
      currency: 'INR', lastUsedOn: null,
      connectors: [{ displayId: 1, connectorId: 1, type: 'CCS-2',
        status: 'available', available: true, note: null }] }],
    amenities: [], summary: null };
}

function detailsResponse(body: any, kw?: unknown, price?: unknown) {
  const stations = (body.stations ?? []) as StationEcho[];
  return envelope('details-bulk', stations.map((s) => ({
    key: s.key, stationId: s.stationId, outcome: 'ok', reason: null,
    upstream: { attempts: 1, statuses: [200], fetchedAt: LATER },
    provenance: { sourceUrlPath: '/station/v1/details', httpStatus: 200,
      contentType: 'application/json', cacheControl: null },
    data: { source: 'Statiq station detail (live)', station: stationDetail(s.stationId, kw, price) },
  })));
}

function bulkClient(opts: {
  maxAttempts: number;
  calls: any[];
  respond: (call: { url: string; body: any }) => { status?: number; body?: string; throw?: Error };
  onAudit?: (entry: UpstreamAuditEntry) => void;
  deadlineOffsetMs?: number;
  collector?: ProviderFailureCollector;
}) {
  const fetchImpl = (async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    const call = { url: String(url), body };
    opts.calls.push(call);
    const r = opts.respond(call);
    if (r.throw) throw r.throw;
    return new Response(r.body ?? '', {
      status: r.status ?? 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-evroute-upstream': 'statiq-live',
      },
    });
  }) as typeof fetch;
  const client = new StatiqClient({
    token: 'offline-only', baseUrl: 'https://worker.test/api', fetchImpl,
    runDeadlineAt: Date.now() + (opts.deadlineOffsetMs ?? 60_000), onUpstreamCall: opts.onAudit,
  });
  const budget = new UpstreamBudget(opts.maxAttempts);
  client.attachRunBudget(budget);
  if (opts.collector) client.attachFailureCollector(opts.collector);
  return { client, budget };
}

const points = [
  { lat: 28.61, lon: 77.21 },
  { lat: 28.62, lon: 77.22 },
  { lat: 28.63, lon: 77.23 },
];

describe('strict bulk marker transport', () => {
  it('accepts a truthful partial ok:false envelope, settles only observed attempts and echoes ordered keys', async () => {
    const calls: any[] = [];
    const { client, budget } = bulkClient({ maxAttempts: 5, calls,
      respond: (call) => ({ body: JSON.stringify(
        markersResponse(call.body, [{}, {}, { outcome: 'not-attempted' }])) }) });
    const results = await client.markersBulk(points);
    expect(calls).toHaveLength(1);
    const sentSquares = calls[0]?.body.squares as SquareEcho[];
    expect(sentSquares.map((s) => s.key)).toEqual(['s0', 's1', 's2']);
    expect(calls[0]?.body.budget.maxUpstreamAttempts).toBe(3);
    // Worker work window is strictly inside the client transport window:
    // a drain margin (~5s) lets the worker's honest deadline envelope arrive.
    expect(calls[0]?.body.deadlineMs).toBeGreaterThanOrEqual(20_000);
    expect(calls[0]?.body.deadlineMs).toBeLessThan(60_000);
    expect(results.map((r) => r.outcome)).toEqual(['ok', 'ok', 'not-attempted']);
    expect(results[0]?.response?.stations[0]?.stationId).toBe(1);
    expect(budget.attemptsMade).toBe(2); // 3 held, 1 observed-unused released
    expect(budget.reservedButUnknown).toBe(0);
    expect(budget.completedAttempts).toBe(2);
  });

  it('audits actual per-item statuses only, never the client envelope or the reservation', async () => {
    const audit: UpstreamAuditEntry[] = [];
    const { client } = bulkClient({ maxAttempts: 6, calls: [],
      respond: (call) => ({ body: JSON.stringify(
        markersResponse(call.body, [{}, {}, { outcome: 'not-attempted' }])) }),
      onAudit: (e) => audit.push(e) });
    await client.markersBulk(points);
    expect(audit).toHaveLength(2);
    expect(audit.map((e) => e.status)).toEqual([200, 200]);
    expect(audit.map((e) => e.endpoint)).toEqual(['station/v1/markers', 'station/v1/markers']);
  });

  it('accepts documented string disposition markers in statuses and histogram', async () => {
    const { client } = bulkClient({ maxAttempts: 6, calls: [],
      respond: (call) => ({ body: JSON.stringify(markersResponse(call.body, [
        {},
        { outcome: 'unknown', reason: 'upstream_timeout', statuses: ['timeout'] },
        { outcome: 'not-attempted' },
      ])) }) });
    const results = await client.markersBulk(points);
    expect(results.map((r) => r.outcome)).toEqual(['ok', 'unknown', 'not-attempted']);
    expect(results[1]?.upstream.statuses).toEqual(['timeout']);
  });

  it('rejects histogram, attempt-sum and success-status inconsistencies without settling', async () => {
    const cases = [
      { opts: { histogram: { '200': 5 }, attempts: 1 } },
      { opts: { attempts: 2, histogram: { '200': 2 } } },
      { opts: {}, mutate: (body: any) => {
          const response = markersResponse(body, [{}]);
          response.items[0].upstream.statuses = [500];
          return response;
        } },
    ];
    for (const testCase of cases) {
      const { client, budget } = bulkClient({ maxAttempts: 4, calls: [],
        respond: (call) => ({ body: JSON.stringify(
          testCase.mutate ? testCase.mutate(call.body) : markersResponse(call.body, [{}], testCase.opts)) }) });
      await expect(client.markersBulk(points.slice(0, 1))).rejects.toBeTruthy();
      expect(budget.attemptsMade).toBe(1);
      expect(budget.reservedButUnknown).toBe(1);
    }
  });

  it('a bad later item leaves zero audited attempts and an untouched full reservation', async () => {
    const audit: UpstreamAuditEntry[] = [];
    const { client, budget } = bulkClient({ maxAttempts: 6, calls: [],
      respond: (call) => {
        const response = markersResponse(call.body, [{}, {}]);
        // Mutate ONE echo on the captured second square; production must reject.
        const second = response.items[1] as { key: string };
        second.key = 'WRONG';
        return { body: JSON.stringify(response) };
      },
      onAudit: (e) => audit.push(e) });
    await expect(client.markersBulk(points.slice(0, 2))).rejects.toBeTruthy();
    expect(audit).toHaveLength(0); // no partial actual-dispatch claim
    expect(budget.attemptsMade).toBe(2); // worst-case hold retained
    expect(budget.reservedButUnknown).toBe(2);
    expect(budget.completedAttempts).toBe(0);
  });

  it('unknown transport latches closed: no second batch and no legacy dispatch', async () => {
    const calls: any[] = [];
    const { client } = bulkClient({ maxAttempts: 6, calls,
      respond: () => ({ throw: new Error('transport down') }) });
    await expect(client.markersBulk(points)).rejects.toBeTruthy();
    expect(calls).toHaveLength(1); // no retry / no legacy resubmission
    await expect(client.markersBulk(points)).rejects.toBeTruthy();
    await expect(client.markers(1, 1)).rejects.toBeTruthy();
    expect(calls).toHaveLength(1); // latch blocks every later dispatch
  });

  it('records bulk failure evidence with real endpoint class, global ordinal and null not-attempted dispatch', async () => {
    const collector = createProviderFailureCollector();
    const calls: any[] = [];
    const manyPoints = Array.from({ length: 13 }, (_, i) => ({ lat: 28.60 + i / 100, lon: 77.20 + i / 100 }));
    const { client } = bulkClient({ maxAttempts: 20, calls, collector,
      respond: (call) => {
        const squares = (call.body.squares ?? []) as SquareEcho[];
        const specs = squares.map((_sq, i) => i === 5
          ? { outcome: 'unknown' as const, reason: 'upstream_timeout', statuses: ['timeout'] }
          : i === 12
            ? { outcome: 'not-attempted' as const, reason: 'budget_exhausted' }
            : {});
        return { body: JSON.stringify(markersResponse(call.body, specs)) };
      } });
    // NO context argument: the transport must derive class/phase from endpoint.
    const results = await client.markersBulk(manyPoints);
    expect(results).toHaveLength(13);
    const failures = collector.snapshot().failures;
    // index 5 is in the first batch, index 12 is in the second (global 6 and 13).
    expect(failures.some((f) => f.endpointClass === 'none')).toBe(false);
    const ordinals = failures.map((f) => f.sampleOrdinal).filter((n) => n != null);
    expect(ordinals).toContain(6);
    expect(ordinals).toContain(13);
    const notAttempted12 = failures.find((f) => f.sampleOrdinal === 13);
    expect(notAttempted12).toMatchObject({
      endpointClass: 'stations/markers',
      phase: 'scan',
      sampleOrdinal: 13,
      dispatchSeq: null,
      httpStatus: null,
    });
    const unknown6 = failures.find((f) => f.sampleOrdinal === 6);
    expect(unknown6).toMatchObject({ endpointClass: 'stations/markers', phase: 'scan' });
  });

  it('accepts only the exact one-fetch raw empty proof', async () => {
    const calls: any[] = [];
    const { client } = bulkClient({ maxAttempts: 2, calls,
      respond: (call) => ({ body: JSON.stringify(
        markersResponse(call.body, [{ outcome: 'confirmed-empty' }])) }) });
    const ok = await client.markersBulk(points.slice(0, 1));
    expect(ok[0]?.outcome).toBe('confirmed-empty');
    expect(ok[0]?.response?.source).toBe('raw-confirmed-empty');
    expect(ok[0]?.response?.stations).toEqual([]);

    const badCalls: any[] = [];
    const { client: bad } = bulkClient({ maxAttempts: 2, calls: badCalls,
      respond: (call) => ({ body: JSON.stringify(markersResponse(call.body,
        [{ outcome: 'confirmed-empty', message: 'some other message' }])) }) });
    await expect(bad.markersBulk(points.slice(0, 1))).rejects.toBeTruthy();
  });
});

describe('bulk details + corridor adoption', () => {
  it('chunks ordered ids at two and rejects malformed charger power/tariff closed', async () => {
    const calls: any[] = [];
    const { client } = bulkClient({ maxAttempts: 4, calls,
      respond: (call) => ({ body: JSON.stringify(detailsResponse(call.body)) }) });
    const results = await client.detailsBulk([2862, 1790, 42]);
    expect(calls).toHaveLength(2); // 2 then 1
    expect((calls[0]?.body.stations as StationEcho[]).map((s) => s.stationId)).toEqual([2862, 1790]);
    expect(results.map((r) => r.response?.response.station?.stationId)).toEqual([2862, 1790, 42]);
    expect(results[0]?.response?.fetchedAt.toISOString()).toBe(LATER);

    for (const [kw, price] of [['bad', 20], [60, 'bad'], [undefined, 20]] as [unknown, unknown][]) {
      const strictCalls: any[] = [];
      const { client: strict } = bulkClient({ maxAttempts: 2, calls: strictCalls,
        respond: (call) => ({ body: JSON.stringify(detailsResponse(call.body, kw, price)) }) });
      await expect(strict.detailsBulk([1])).rejects.toBeTruthy();
    }
  });

  it('scanCorridor drives one bulk batch and preserves global ordinals via callback', async () => {
    let bulkCalls = 0;
    let legacyCalls = 0;
    const seenOrdinals: number[] = [];
    const source: BulkMarkerSource = {
      markers: async () => { legacyCalls++; throw new Error('legacy must not run'); },
      markersBulk: async (
        pointsIn: readonly { lat: number; lon: number }[],
        _signal?: AbortSignal,
        _context?: import('../src/provider-failure.js').ProviderCallContext,
        onItem?: (result: any, index: number) => void,
      ) => {
        bulkCalls++;
        const items = pointsIn.map((_p, i) => ({
          outcome: 'ok' as const, reason: null,
          upstream: { attempts: 1, statuses: [200], fetchedAt: LATER },
          response: { ok: true, live: true, retained: false, source: 'bulk',
            count: 1, stations: [marker(100 + i)] },
        }));
        items.forEach((item, i) => { seenOrdinals.push(i + 1); onItem?.(item, i); });
        return items;
      },
    };
    const result = await scanCorridor(source, [
      { lat: 28.6, lon: 77.2 },
      { lat: 28.61, lon: 77.21 },
      { lat: 28.62, lon: 77.22 },
    ], { stepKm: 12 });
    expect(bulkCalls).toBe(1);
    expect(legacyCalls).toBe(0);
    expect(result.samples).toBe(result.samplesPlanned);
    expect(result.failedSamples).toEqual([]);
    expect(seenOrdinals).toEqual(Array.from({ length: result.samplesPlanned }, (_, i) => i + 1));
  });

  it('refuses to dispatch when the absolute deadline cannot fit a safe batch lifecycle', async () => {
    const calls: any[] = [];
    const { client } = bulkClient({ maxAttempts: 6, calls,
      respond: (call) => ({ body: JSON.stringify(markersResponse(call.body, [{}])) }),
      deadlineOffsetMs: 1_000 });
    await expect(client.markersBulk(points)).rejects.toBeInstanceOf(StatiqAbortError);
    expect(calls).toHaveLength(0); // no dispatch, no orphan, no retry
  });
});
