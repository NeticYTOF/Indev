/**
 * Strict bulk transport: envelope cross-checks, pessimistic reservation and
 * settlement, per-item audit, unknown-state latch, exact empty proof, and real
 * corridor adoption. Offline only - fake transport, no provider calls.
 */
import { describe, expect, it } from 'vitest';
import { StatiqClient, type UpstreamAuditEntry } from '../src/statiq.js';
import { UpstreamBudget, UpstreamRunStoppedError } from '../src/upstream-budget.js';
import { scanCorridor } from '../src/corridor.js';

const NOW = '2026-11-21T10:00:00.000Z';
const LATER = '2026-11-21T10:00:01.000Z';
const VERTICES: number[][] = [[77.1, 28.5], [77.3, 28.5], [77.3, 28.7], [77.1, 28.7], [77.1, 28.5]];

function marker(id: number) {
  return { stationId: id, name: `Station ${id}`, lat: 28.6 + id / 1000, lon: 77.2 + id / 1000,
    address: null, accessType: 1, isCommunityListed: false, stationUrl: '' };
}

function baseItem(key: string) {
  return {
    key, latitude: 28.6, longitude: 77.2, vertices: VERTICES,
    outcome: 'ok' as string, reason: null as string | null,
    upstream: { attempts: 1, statuses: [200] as (number | string)[], fetchedAt: LATER as string | null },
    provenance: null as Record<string, unknown> | null,
    data: null as unknown,
  };
}

function okItem(key: string, ids: number[]) {
  const stations = ids.map(marker);
  return {
    ...baseItem(key), outcome: 'ok',
    upstream: { attempts: 1, statuses: [200], fetchedAt: LATER },
    provenance: { sourceUrlPath: '/station/v1/markers', httpStatus: 200,
      contentType: 'application/json; charset=utf-8', cacheControl: null },
    data: { source: 'Statiq station markers (live)', count: stations.length, stations },
  };
}

function notAttempted(key: string) {
  return {
    ...baseItem(key), outcome: 'not-attempted', reason: 'budget_exhausted',
    upstream: { attempts: 0, statuses: [], fetchedAt: null },
    provenance: null,
  };
}

function emptyItem(key: string, message = 'No stations found with selected filters') {
  return {
    ...baseItem(key), outcome: 'confirmed-empty',
    upstream: { attempts: 1, statuses: [200], fetchedAt: LATER },
    provenance: { sourceUrlPath: '/station/v1/markers', httpStatus: 200,
      contentType: 'application/json', cacheControl: null },
    data: null,
    confirmation: { sourceUrlPath: '/station/v1/markers', httpStatus: 200,
      contentType: 'application/json', cacheControl: null, fetchedAt: LATER,
      statusCode: 1001, success: false, message, stationsCount: 0 },
  };
}

function envelope(endpoint: 'markers-bulk' | 'details-bulk', items: any[], opts: {
  attempts?: number; histogram?: Record<string, number>;
  ok?: boolean; completed?: number; attempted?: number;
} = {}) {
  const attempts = opts.attempts ?? items.reduce((n, i) => n + i.upstream.attempts, 0);
  const completed = opts.completed ?? items.filter((i) => i.outcome === 'ok' || i.outcome === 'confirmed-empty').length;
  const attempted = opts.attempted ?? items.filter((i) => i.upstream.attempts > 0).length;
  return {
    ok: opts.ok ?? (completed === items.length),
    live: true, retained: false, endpoint,
    startedAt: NOW, completedAt: LATER,
    deadline: { ms: 150000, hit: false },
    requestedItems: items.length, attemptedItems: attempted, completedItems: completed,
    upstreamAttempts: attempts,
    upstreamByStatus: opts.histogram ?? (attempts ? { '200': attempts } : {}),
    items,
  };
}

function bulkClient(opts: {
  maxAttempts: number;
  calls: any[];
  respond: (call: any) => { status?: number; body?: string; throw?: Error };
  onAudit?: (entry: UpstreamAuditEntry) => void;
}) {
  const fetchImpl = (async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    opts.calls.push({ url: String(url), body });
    const r = opts.respond({ url: String(url), body });
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
    runDeadlineAt: Date.now() + 60_000, onUpstreamCall: opts.onAudit,
  });
  const budget = new UpstreamBudget(opts.maxAttempts);
  client.attachRunBudget(budget);
  return { client, budget };
}

const points = [
  { lat: 28.61, lon: 77.21 },
  { lat: 28.62, lon: 77.22 },
  { lat: 28.63, lon: 77.23 },
];

function successfulClient(items: any[], maxAttempts = 6) {
  const calls: any[] = [];
  const client = bulkClient({ maxAttempts, calls,
    respond: () => ({ body: JSON.stringify(envelope('markers-bulk', items)) }) });
  return { ...client, calls };
}

describe('strict bulk marker transport', () => {
  it('accepts a truthful partial ok:false envelope, settles only observed attempts and echoes ordered keys', async () => {
    const calls: any[] = [];
    const items = [okItem('s0', [1]), okItem('s1', [2]), notAttempted('s2')];
    const { client, budget } = bulkClient({ maxAttempts: 5, calls,
      respond: () => ({ body: JSON.stringify(envelope('markers-bulk', items)) }) });
    const results = await client.markersBulk(points);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.budget.maxUpstreamAttempts).toBe(3);
    expect(calls[0].body.deadlineMs).toBeGreaterThan(0);
    expect(calls[0].body.squares.map((s: any) => s.key)).toEqual(['s0', 's1', 's2']);
    expect(results.map((r) => r.outcome)).toEqual(['ok', 'ok', 'not-attempted']);
    expect(results[0].response?.stations[0]?.stationId).toBe(1);
    expect(budget.attemptsMade).toBe(2); // 3 held, 1 observed-unused released
    expect(budget.reservedButUnknown).toBe(0);
    expect(budget.completedAttempts).toBe(2);
  });

  it('audits actual per-item statuses only, never the client envelope or the reservation', async () => {
    const audit: UpstreamAuditEntry[] = [];
    const items = [okItem('s0', [1]), okItem('s1', [2]), notAttempted('s2')];
    const { client } = bulkClient({ maxAttempts: 6, calls: [],
      respond: () => ({ body: JSON.stringify(envelope('markers-bulk', items)) }),
      onAudit: (e) => audit.push(e) });
    await client.markersBulk(points);
    expect(audit).toHaveLength(2);
    expect(audit.map((e) => e.status)).toEqual([200, 200]);
    expect(audit.map((e) => e.endpoint)).toEqual(['station/v1/markers', 'station/v1/markers']);
  });

  it('accepts documented string disposition markers in statuses and histogram', async () => {
    const unknown = {
      ...baseItem('s1'), outcome: 'unknown', reason: 'upstream_timeout',
      upstream: { attempts: 1, statuses: ['timeout'], fetchedAt: LATER }, provenance: null,
    };
    const items = [okItem('s0', [1]), unknown, notAttempted('s2')];
    const { client } = bulkClient({ maxAttempts: 6, calls: [],
      respond: () => ({ body: JSON.stringify(envelope('markers-bulk', items,
        { histogram: { '200': 1, timeout: 1 } })) }) });
    const results = await client.markersBulk(points);
    expect(results.map((r) => r.outcome)).toEqual(['ok', 'unknown', 'not-attempted']);
    expect(results[1].upstream.statuses).toEqual(['timeout']);
  });

  it('rejects histogram, attempt-sum and success-status inconsistencies without settling', async () => {
    const ok = okItem('s0', [1]);
    const cases = [
      envelope('markers-bulk', [ok], { histogram: { '200': 5 }, attempts: 1 }),
      envelope('markers-bulk', [ok], { attempts: 2, histogram: { '200': 2 } }),
      envelope('markers-bulk', [{ ...ok, upstream: { attempts: 1, statuses: [500], fetchedAt: LATER } }]),
    ];
    for (const body of cases) {
      const { client, budget } = bulkClient({ maxAttempts: 4, calls: [],
        respond: () => ({ body: JSON.stringify(body) }) });
      await expect(client.markersBulk(points.slice(0, 1))).rejects.toBeTruthy();
      expect(budget.attemptsMade).toBe(1);
      expect(budget.reservedButUnknown).toBe(1);
    }
  });

  it('rejects echo and identity mismatches before settling', async () => {
    const badVertex = okItem('s0', [1]);
    badVertex.vertices = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
    const badKey = okItem('WRONG', [1]);
    for (const items of [[badVertex], [badKey]]) {
      const { client, budget } = bulkClient({ maxAttempts: 4, calls: [],
        respond: () => ({ body: JSON.stringify(envelope('markers-bulk', items)) }) });
      await expect(client.markersBulk(points.slice(0, 1))).rejects.toBeTruthy();
      expect(budget.attemptsMade).toBe(1);
      expect(budget.reservedButUnknown).toBe(1);
    }
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

  it('accepts only the exact one-fetch raw empty proof', async () => {
    const { client } = successfulClient([emptyItem('s0')]);
    const ok = await client.markersBulk(points.slice(0, 1));
    expect(ok[0].outcome).toBe('confirmed-empty');
    expect(ok[0].response?.source).toBe('raw-confirmed-empty');
    expect(ok[0].response?.stations).toEqual([]);

    const { client: bad } = bulkClient({ maxAttempts: 2, calls: [],
      respond: () => ({ body: JSON.stringify(envelope('markers-bulk',
        [emptyItem('s0', 'some other message')], { attempts: 1 })) }) });
    await expect(bad.markersBulk(points.slice(0, 1))).rejects.toBeTruthy();
  });
});

describe('bulk details + corridor adoption', () => {
  it('chunks ordered ids at two and rejects malformed charger power/tariff closed', async () => {
    const calls: any[] = [];
    const station = (id: number, kw: unknown = 60, price: unknown = 20) => ({
      stationId: id, name: `S${id}`, lat: 28.6, lon: 77.2, address: null,
      chargers: [{ chargerId: 1, name: 'DC', type: 'DC', kw, pricePerKwh: price,
        currency: 'INR', lastUsedOn: null,
        connectors: [{ displayId: 1, connectorId: 1, type: 'CCS-2',
          status: 'available', available: true, note: null }] }],
      amenities: [], summary: null,
    });
    const detailItem = (key: string, id: number, s: any) => ({
      key, stationId: id, outcome: 'ok', reason: null,
      upstream: { attempts: 1, statuses: [200], fetchedAt: LATER },
      provenance: { sourceUrlPath: '/station/v1/details', httpStatus: 200,
        contentType: 'application/json', cacheControl: null },
      data: { source: 'Statiq station detail (live)', station: s },
    });
    const { client } = bulkClient({ maxAttempts: 4, calls,
      respond: (call) => {
        const ids = call.body.stations.map((s: any) => s.stationId as number);
        const items = ids.map((id, j) => detailItem(`d${j}`, id, station(id)));
        return { body: JSON.stringify(envelope('details-bulk', items)) };
      } });
    const results = await client.detailsBulk([2862, 1790, 42]);
    expect(calls).toHaveLength(2); // 2 then 1
    expect(calls[0].body.stations.map((s: any) => s.stationId)).toEqual([2862, 1790]);
    expect(results.map((r) => r.response?.response.station?.stationId)).toEqual([2862, 1790, 42]);
    expect(results[0].response?.fetchedAt.toISOString()).toBe(LATER);

    for (const [kw, price] of [['bad', 20], [60, 'bad'], [undefined, 20]] as [unknown, unknown][]) {
      const { client: strict } = bulkClient({ maxAttempts: 2, calls: [],
        respond: () => ({ body: JSON.stringify(envelope('details-bulk',
          [detailItem('d0', 1, station(1, kw, price))])) }) });
      await expect(strict.detailsBulk([1])).rejects.toBeTruthy();
    }
  });

  it('scanCorridor drives one bulk batch and preserves global ordinals via callback', async () => {
    let bulkCalls = 0;
    let legacyCalls = 0;
    const seenOrdinals: number[] = [];
    const result = await scanCorridor({
      markers: async () => { legacyCalls++; throw new Error('legacy must not run'); },
      markersBulk: async (pointsIn: readonly { lat: number; lon: number }[], _s: any, _c: any,
        onItem: (r: any, i: number) => void) => {
        bulkCalls++;
        const items = pointsIn.map((_p, i) => ({
          outcome: 'ok', reason: null,
          upstream: { attempts: 1, statuses: [200], fetchedAt: LATER },
          response: { ok: true, live: true, retained: false, source: 'bulk',
            count: 1, stations: [marker(100 + i)] },
        }));
        items.forEach((item, i) => { seenOrdinals.push(i + 1); onItem(item as any, i); });
        return items as any;
      },
    }, [
      { lat: 28.6, lon: 77.2 },
      { lat: 28.61, lon: 77.21 },
      { lat: 28.62, lon: 77.22 },
    ], { stepKm: 12 });
    expect(bulkCalls).toBe(1);
    expect(legacyCalls).toBe(0);
    expect(result.samples).toBe(result.samplesPlanned);
    expect(result.failedSamples).toEqual([]);
    expect(seenOrdinals).toEqual(result.samplesPlanned > 0
      ? Array.from({ length: result.samplesPlanned }, (_, i) => i + 1) : []);
  });
});
