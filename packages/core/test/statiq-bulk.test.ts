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
import { StatiqAbortError, StatiqClient, StatiqProvenanceError, type UpstreamAuditEntry } from '../src/statiq.js';
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

/** Live round-mode worker: <= 40 items per round (capped by the request
 *  budget), opaque cursor = next offset, continuation null when done. */
function roundResponse(body: any) {
  const all = (body.stations ?? []) as StationEcho[];
  const offset = body.cursor ? Number(atob(body.cursor)) : 0;
  const size = Math.min(40, body.budget.maxUpstreamAttempts, all.length - offset);
  const page = detailsResponse({ stations: all.slice(offset, offset + size) }) as any;
  const end = offset + size;
  return { ...page, requestedItems: all.length, round: { offset, size },
    continuation: end < all.length
      ? { cursor: btoa(String(end)), offset: end, remainingCount: all.length - end, totalItems: all.length }
      : null,
    unprocessedCount: 0 };
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
        // Keys are global (s0..s12); use them, not the per-batch local index.
        const specs = squares.map((sq) => {
          const global = Number(sq.key.replace(/^s/, ''));
          return global === 5
            ? { outcome: 'unknown' as const, reason: 'upstream_timeout', statuses: ['timeout'] }
            : global === 12
              ? { outcome: 'not-attempted' as const, reason: 'budget_exhausted' }
              : {};
        });
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
  it('accepts the live worker string status "500" for one failed item, keeping the rest', async () => {
    // Shape captured live (23 Nov 2026): the upgraded worker emits failed
    // upstream statuses as decimal strings in both the item and histogram.
    const { client, budget } = bulkClient({ maxAttempts: 4, calls: [],
      respond: (call) => {
        const response = detailsResponse(call.body) as any;
        const bad = response.items[1];
        Object.assign(bad, { outcome: 'unknown', reason: 'upstream_error', data: null,
          upstream: { attempts: 1, statuses: ['500'], fetchedAt: LATER },
          provenance: { sourceUrlPath: '/station/v1/details', httpStatus: 500,
            contentType: 'application/json', cacheControl: null } });
        response.ok = false;
        response.completedItems = response.items.length - 1;
        response.upstreamByStatus = { '200': response.items.length - 1, '500': 1 };
        return { body: JSON.stringify(response) };
      } });
    const results = await client.detailsBulk([11, 12, 13]);
    expect(results.map((r) => r.outcome)).toEqual(['ok', 'unknown', 'ok']);
    expect(results[1]?.upstream.statuses).toEqual([500]);
    expect(budget.completedAttempts).toBe(3);
  });

  it.each(['0500', ' 500', '5e2', '600', '-1', '500.0'])('rejects non-canonical status string %j closed', async (status) => {
    const { client } = bulkClient({ maxAttempts: 2, calls: [],
      respond: (call) => {
        const response = detailsResponse(call.body) as any;
        Object.assign(response.items[0], { outcome: 'unknown', reason: 'upstream_error', data: null,
          upstream: { attempts: 1, statuses: [status], fetchedAt: LATER } });
        response.ok = false; response.completedItems = 0;
        response.upstreamByStatus = { [status]: 1 };
        return { body: JSON.stringify(response) };
      } });
    await expect(client.detailsBulk([11])).rejects.toBeTruthy();
  });

  it('sends one 700-station series, follows cursor rounds in order, and splits at 700', async () => {
    const calls: any[] = [];
    const ids = Array.from({ length: 705 }, (_, i) => 1000 + i);
    const seen: number[] = [];
    const { client, budget } = bulkClient({ maxAttempts: 800, calls,
      respond: (call) => ({ body: JSON.stringify(roundResponse(call.body)) }) });
    const results = await client.detailsBulk(ids, undefined, undefined, (_r, index) => seen.push(index));
    // 700 -> 18 rounds of <= 40; then a fresh 5-station series.
    expect(calls).toHaveLength(19);
    expect(calls[0]?.body.stations).toHaveLength(700);
    expect(calls[0]?.body.cursor).toBeUndefined();
    expect(calls[1]?.body.cursor).toBe(btoa('40'));
    expect(calls[1]?.body.stations).toEqual(calls[0]?.body.stations); // same list every round
    expect((calls[18]?.body.stations as StationEcho[]).map((s) => s.stationId)).toEqual(ids.slice(700));
    expect(calls[18]?.body.stations[0].key).toBe('d700');
    expect(results.map((r) => r.response?.response.station?.stationId)).toEqual(ids);
    expect(seen).toEqual(ids.map((_, i) => i));
    expect(budget.completedAttempts).toBe(705);
    expect(budget.reservedButUnknown).toBe(0);
  });

  it.each([
    ['skipped offset', (e: any) => { e.round.offset = 1; }],
    ['continuation offset mismatch', (e: any) => { e.continuation.offset += 1; }],
    ['remainingCount mismatch', (e: any) => { e.continuation.remainingCount -= 1; }],
    ['missing cursor while positions remain', (e: any) => { e.continuation = null; }],
    ['round size disagrees with items', (e: any) => { e.round.size += 1; }],
  ])('fails a details series closed on %s', async (_label, mutate) => {
    const calls: any[] = [];
    const ids = Array.from({ length: 60 }, (_, i) => 1 + i);
    const { client, budget } = bulkClient({ maxAttempts: 100, calls,
      respond: (call) => {
        const response = roundResponse(call.body);
        if (!call.body.cursor) mutate(response);
        return { body: JSON.stringify(response) };
      } });
    await expect(client.detailsBulk(ids)).rejects.toBeTruthy();
    expect(calls).toHaveLength(1); // never follows a bad round
    expect(budget.completedAttempts).toBe(0);
    await expect(client.detailsBulk([1])).rejects.toBeTruthy(); // latched
    expect(calls).toHaveLength(1);
  });

  it('a throttled item in a round stops the series before the next round', async () => {
    const calls: any[] = [];
    const ids = Array.from({ length: 90 }, (_, i) => 1 + i);
    const { client } = bulkClient({ maxAttempts: 200, calls,
      respond: (call) => {
        const response = roundResponse(call.body) as any;
        const bad = response.items[3];
        Object.assign(bad, { outcome: 'unknown', reason: 'upstream_throttled', data: null,
          upstream: { attempts: 1, statuses: [429], fetchedAt: LATER },
          provenance: { sourceUrlPath: '/station/v1/details', httpStatus: 429,
            contentType: 'application/json', cacheControl: null } });
        response.ok = false;
        response.completedItems -= 1;
        response.upstreamByStatus = { '200': response.items.length - 1, '429': 1 };
        return { body: JSON.stringify(response) };
      } });
    await expect(client.detailsBulk(ids)).rejects.toMatchObject({ name: 'StatiqRunFatalError' });
    expect(calls).toHaveLength(1);
  });

  it('rejects malformed charger power/tariff closed', async () => {

    for (const [kw, price] of [['bad', 20], [60, 'bad'], [undefined, 20]] as [unknown, unknown][]) {
      const strictCalls: any[] = [];
      const { client: strict } = bulkClient({ maxAttempts: 2, calls: strictCalls,
        respond: (call) => {
          const response = detailsResponse(call.body);
          // Inject the malformed values into the normalized station payload;
          // the strict validator must fail the item closed.
          for (const item of response.items) item.data.station.chargers[0].kw = kw;
          for (const item of response.items) item.data.station.chargers[0].pricePerKwh = price;
          return { body: JSON.stringify(response) };
        } });
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

describe('bulk details summary statusCounts wire contract', () => {
  const AC_ONLY_CHARGERS = [{
    chargerId: 2, name: 'AC', type: 'AC', kw: 7, pricePerKwh: 10,
    currency: 'INR', lastUsedOn: null,
    connectors: [{ displayId: 1, connectorId: 2, type: 'Type-2',
      status: 'available', available: true, note: null }],
  }];

  function summaryResponse(
    call: { body: unknown },
    statusCounts: unknown,
    chargers?: unknown,
    omit = false,
  ) {
    const response = detailsResponse(call.body);
    for (const item of response.items) {
      item.data.station.summary = {
        anyDc: true, ccs2Dc: true, maxDcCcs2Kw: 60, availableNow: true,
        ...(omit ? {} : { statusCounts }),
      };
      if (chargers !== undefined) item.data.station.chargers = chargers;
    }
    return { body: JSON.stringify(response) };
  }

  it('accepts the worker null for AC-only and DC-empty stations and preserves null', async () => {
    for (const chargers of [AC_ONLY_CHARGERS, []]) {
      const { client, budget } = bulkClient({ maxAttempts: 2, calls: [],
        respond: (call) => summaryResponse(call, null, chargers) });
      const results = await client.detailsBulk([1]);
      expect(results).toHaveLength(1);
      const summary = results[0]?.response?.response.station?.summary;
      expect(summary).not.toBeNull();
      expect(summary!.statusCounts).toBeNull();
      expect(budget.completedAttempts).toBe(1);
    }
  });

  it('keeps a known-empty record and a valid count record distinct from null', async () => {
    const cases: Array<[unknown, Record<string, number>]> = [
      [{}, {}],
      [{ available: 2, occupied: 1 }, { available: 2, occupied: 1 }],
    ];
    for (const [wire, expected] of cases) {
      const { client } = bulkClient({ maxAttempts: 2, calls: [],
        respond: (call) => summaryResponse(call, wire) });
      const results = await client.detailsBulk([1]);
      const summary = results[0]?.response?.response.station?.summary;
      expect(summary).not.toBeNull();
      expect(summary!.statusCounts).toEqual(expected);
      expect(summary!.statusCounts).not.toBeNull();
    }
  });

  it('fails malformed or absent statusCounts closed without audits or settlement', async () => {
    const bad: Array<{ label: string; statusCounts?: unknown; omit?: boolean }> = [
      { label: 'scalar', statusCounts: 5 },
      { label: 'array', statusCounts: [] },
      { label: 'absent', omit: true },
      { label: 'negative count', statusCounts: { available: -1 } },
      { label: 'fractional count', statusCounts: { available: 1.5 } },
      { label: 'string count', statusCounts: { available: '2' } },
      { label: 'null count', statusCounts: { available: null } },
      { label: 'array count', statusCounts: { available: [] } },
      { label: 'object count', statusCounts: { available: {} } },
      { label: 'nan count', statusCounts: { available: Number.NaN } },
      { label: 'infinite count', statusCounts: { available: Number.POSITIVE_INFINITY } },
    ];
    for (const c of bad) {
      const audit: UpstreamAuditEntry[] = [];
      const { client, budget } = bulkClient({ maxAttempts: 2, calls: [],
        respond: (call) => summaryResponse(call, c.statusCounts, undefined, c.omit),
        onAudit: (e) => audit.push(e) });
      const err = await client.detailsBulk([1]).catch((e: unknown) => e);
      expect(err, c.label).toBeInstanceOf(StatiqProvenanceError);
      expect((err as StatiqProvenanceError).reason, c.label).toBe('item_detail_summary');
      expect(audit, c.label).toHaveLength(0);
      expect(budget.attemptsMade, c.label).toBe(1);
      expect(budget.reservedButUnknown, c.label).toBe(1);
      expect(budget.completedAttempts, c.label).toBe(0);
    }
  });
});
