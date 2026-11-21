/**
 * REAL StatiqClient with explicit bulk opt-in over a wire-shaped fake bulk
 * transport. Client deadline stays 60s (above the 25s safe-batch guard).
 * Cancellation at planner level uses AbortSignal.any with an external
 * controller passed through a thin wrapper (standard supported API).
 * Every gate await is bounded and every pending promise is awaited in finally.
 */
import { describe, expect, it } from 'vitest';
import { OsrmRouter } from '../src/router.js';
import { planTrip } from '../src/planner.js';
import {
  StatiqAbortError, StatiqClient, type UpstreamAuditEntry,
} from '../src/statiq.js';
import { UpstreamBudget, UpstreamRunStoppedError } from '../src/upstream-budget.js';
import type { ProviderCallContext } from '../src/provider-failure.js';

const KM_PER_DEG = 111.32;
const NOW = '2026-11-21T10:00:00.000Z';
const LATER = '2026-11-21T10:00:01.000Z';
const ctx: ProviderCallContext = { endpointClass: 'stations/markers', phase: 'scan' };

interface Gate { promise: Promise<void>; resolve: () => void; done: () => boolean; }
function gate(): Gate {
  let open = false, resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = () => { open = true; done(); }; });
  return { promise, resolve, done: () => open };
}
async function waitResult<T>(promise: Promise<T>, label: string, limitMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_ok, fail) => {
        timer = setTimeout(() => fail(new Error(`timed out waiting for ${label}`)), limitMs);
      }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function wait(promise: Promise<void> | (() => boolean), label: string, limitMs = 2000): Promise<void> {
  if (typeof promise === 'function') {
    const start = Date.now();
    while (!promise()) {
      if (Date.now() - start > limitMs) throw new Error(`timed out waiting for ${label}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_ok, fail) => {
        timer = setTimeout(() => fail(new Error(`timed out waiting for ${label}`)), limitMs);
      }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

const station = {
  stationId: 1, name: 'Fixture station', lat: 150 / KM_PER_DEG, lon: 0,
  address: null, area: null, city: null, landmark: null, hours: null, openText: null,
  rating: null, reviewCount: null, accessType: 'public', navUrl: '', stationUrl: '',
  imageUrl: null, amenities: [], stepsToReach: null,
  chargers: [{ chargerId: 11, name: 'DC', type: 'DC', kw: 60, pricePerKwh: 20,
    currency: 'INR', lastUsedOn: null,
    connectors: [{ displayId: 1, connectorId: 101, type: 'CCS-2', status: 'available',
      available: true, note: null }] }],
  summary: { anyDc: true, ccs2Dc: true, maxDcCcs2Kw: 60, availableNow: true, statusCounts: {} },
};
interface MarkerSquare { key: string; latitude: number; longitude: number; vertices: number[][] }
function markerItem(square: MarkerSquare, near: boolean) {
  const common = {
    key: square.key, latitude: square.latitude, longitude: square.longitude, vertices: square.vertices,
    upstream: { attempts: 1, statuses: [200], fetchedAt: LATER },
    provenance: { sourceUrlPath: '/station/v1/markers', httpStatus: 200,
      contentType: 'application/json', cacheControl: null },
    reason: null,
  };
  if (!near) return { ...common, outcome: 'confirmed-empty', data: null,
    confirmation: { ...common.provenance, fetchedAt: LATER, statusCode: 1001,
      success: false, message: 'No stations found with selected filters', stationsCount: 0 } };
  return { ...common, outcome: 'ok', data: {
    source: 'Statiq station markers (live)', count: 1,
    stations: [{ stationId: 1, name: station.name, lat: station.lat, lon: station.lon,
      address: null, accessType: 1, isCommunityListed: false, stationUrl: '' }],
  } };
}
function bulkEnvelope(endpoint: 'markers-bulk' | 'details-bulk', items: unknown[]) {
  return {
    ok: items.every((i: any) => i.outcome === 'ok' || i.outcome === 'confirmed-empty'),
    live: true, retained: false, endpoint,
    startedAt: NOW, completedAt: LATER, deadline: { ms: 150000, hit: false },
    requestedItems: items.length, attemptedItems: items.length, completedItems: items.length,
    upstreamAttempts: items.length, upstreamByStatus: { '200': items.length }, items,
  };
}
const BULK_HEADERS: Record<string, string> = {
  'content-type': 'application/json', 'cache-control': 'no-store',
  'x-evroute-upstream': 'statiq-live',
};

type BatchMode = 'ok' | 'transport-fail' | 'bad-envelope';
interface HarnessOpts {
  markerGates?: Gate[];
  detailsGate?: Gate;
  dispatchNotice?: (target: string) => void;
  /** Real fetch-start event, resolved BEFORE any gate wait. */
  fetchStarted?: () => void;
  /** Explicit per-marker-batch outcome; 1-based. */
  markerModes?: BatchMode[];
  /** Return a valid success even after the request signal aborted. */
  uncooperativeLateSuccess?: boolean;
  throttleMarkers?: boolean;
  routeKm?: number;
}
interface Harness {
  client: StatiqClient;
  router: OsrmRouter;
  audit: UpstreamAuditEntry[];
  markerCalls: number;
  detailCalls: number;
  legacyCalls: number;
  markerSquares: number[];
  markerBatchCount: () => number;
}

function harness(opts: HarnessOpts = {}): Harness {
  const audit: UpstreamAuditEntry[] = [];
  let markerCalls = 0, detailCalls = 0, legacyCalls = 0, markerBatchNo = 0;
  const markerSquares: number[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    const target = String(url);
    const signal = init?.signal as AbortSignal | undefined;
    if (target.endsWith('/stations/markers-bulk') || target.endsWith('/stations/details-bulk')) {
      opts.fetchStarted?.();
      opts.dispatchNotice?.(target);
    }
    const waitGate = async (maybe: Gate | undefined, label: string): Promise<void> => {
      if (!maybe) return;
      await wait(maybe.promise, label);
    };
    if (target.endsWith('/stations/markers-bulk')) {
      markerCalls++;
      markerBatchNo++;
      const body = JSON.parse(init.body);
      const squares = body.squares as MarkerSquare[];
      markerSquares.push(squares.length);
      const mode = opts.markerModes?.[Math.min(markerBatchNo, opts.markerModes.length) - 1] ?? 'ok';
      const gateFor = opts.markerGates?.[Math.min(markerBatchNo, opts.markerGates.length) - 1];
      await waitGate(gateFor, `marker gate ${markerBatchNo}`);
      if (mode === 'transport-fail') throw new Error(`marker batch ${markerBatchNo} failed`);
      if (!opts.uncooperativeLateSuccess && signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (opts.throttleMarkers && markerBatchNo === 1) {
        return new Response(JSON.stringify({ ok: false, error: { code: 'throttled' }, upstreamAttempts: 0 }),
          { status: 429, headers: { ...BULK_HEADERS, 'retry-after': '30' } });
      }
      const items = squares.map((s) => markerItem(s, Math.abs(s.latitude * KM_PER_DEG - 150) <= 13));
      const payload = mode === 'bad-envelope'
        ? { ...bulkEnvelope('markers-bulk', items), requestedItems: items.length + 1 }
        : bulkEnvelope('markers-bulk', items);
      return new Response(JSON.stringify(payload), { status: 200, headers: BULK_HEADERS });
    }
    if (target.endsWith('/stations/details-bulk')) {
      detailCalls++;
      const body = JSON.parse(init.body);
      await waitGate(opts.detailsGate, 'details gate');
      if (!opts.uncooperativeLateSuccess && signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const stations = body.stations as Array<{ key: string; stationId: number }>;
      const items = stations.map((s) => ({
        key: s.key, stationId: s.stationId, outcome: 'ok', reason: null,
        upstream: { attempts: 1, statuses: [200], fetchedAt: LATER },
        provenance: { sourceUrlPath: '/station/v1/details', httpStatus: 200,
          contentType: 'application/json', cacheControl: null },
        data: { source: 'Statiq station detail (live)', station: { ...station, stationId: s.stationId } },
      }));
      return new Response(JSON.stringify(bulkEnvelope('details-bulk', items)),
        { status: 200, headers: BULK_HEADERS });
    }
    legacyCalls++;
    return new Response(JSON.stringify({ ok: true, stations: [], count: 0 }));
  }) as typeof fetch;
  const client = new StatiqClient({
    token: 'offline-only', baseUrl: 'https://worker.test/api', fetchImpl, bulk: true,
    minCallGapMs: 1, maxCallsPerMinute: 10000, retries: 0,
    runDeadlineAt: Date.now() + 60_000, onUpstreamCall: (e) => audit.push(e),
  });
  client.attachRunBudget(new UpstreamBudget(200));
  const routeKm = opts.routeKm ?? 200;
  const router = { route: async () => ({
    distanceKm: routeKm, durationMin: routeKm,
    geometry: Array.from({ length: 21 }, (_, i) => ({ lat: (routeKm / KM_PER_DEG) * (i / 20), lon: 0 })),
  }) } as unknown as OsrmRouter;
  return { client, router, audit,
    get markerCalls() { return markerCalls; },
    get detailCalls() { return detailCalls; },
    get legacyCalls() { return legacyCalls; },
    markerSquares, markerBatchCount: () => markerBatchNo };
}

/** Thin wrapper combining the planner's signal with an external controller.
 *  Uses standard AbortSignal.any so planner receives a real cancellation. */
function cancellable(client: StatiqClient, external: AbortSignal) {
  return {
    bulkSupported: () => client.bulkSupported(),
    attachRunBudget: (budget: UpstreamBudget, collector?: any) =>
      client.attachRunBudget(budget, collector),
    markers: (lat: number, lon: number, signal?: AbortSignal, context?: ProviderCallContext) =>
      client.markers(lat, lon, signal ? AbortSignal.any([signal, external]) : external, context),
    detailsWithMeta: (id: number, signal?: AbortSignal, context?: ProviderCallContext) =>
      client.detailsWithMeta(id, signal ? AbortSignal.any([signal, external]) : external, context),
    markersBulk: (points: readonly { lat: number; lon: number }[], signal?: AbortSignal,
      context?: ProviderCallContext, onItem?: any) =>
      client.markersBulk(points, signal ? AbortSignal.any([signal, external]) : external, context, onItem),
    detailsBulk: (ids: readonly number[], signal?: AbortSignal,
      context?: ProviderCallContext, onItem?: any) =>
      client.detailsBulk(ids, signal ? AbortSignal.any([signal, external]) : external, context, onItem),
  } as unknown as StatiqClient;
}

const O = { label: 'Origin', lat: 0, lon: 0 };
const D = (km: number) => ({ label: 'Destination', lat: km / KM_PER_DEG, lon: 0 });
const OPTS = { startSocPct: 50 };
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

describe('real bulk wire lifecycle', () => {
  it('plans with honest dispatch and audit counts', async () => {
    const h = harness();
    const plan = await planTrip({ router: h.router, statiq: h.client }, O, D(200), OPTS);
    expect(plan.stops).toHaveLength(1);
    expect(h.markerCalls).toBe(2);
    expect(h.detailCalls).toBe(1);
    expect(h.legacyCalls).toBe(0);
    expect(h.markerSquares).toEqual([12, 6]);
    expect(h.audit).toHaveLength(19);
    expect(h.audit.every((e) => e.status === 200)).toBe(true);
  });

  it('capability is explicit: injected fetch without opt-in stays legacy', () => {
    const legacy = new StatiqClient({ token: 'offline-only', baseUrl: 'https://worker.test/api',
      fetchImpl: (async () => new Response('{}')) as typeof fetch });
    expect(legacy.bulkSupported()).toBe(false);
    const opted = new StatiqClient({ token: 'offline-only', baseUrl: 'https://worker.test/api',
      fetchImpl: (async () => new Response('{}')) as typeof fetch, bulk: true });
    expect(opted.bulkSupported()).toBe(true);
  });

  it('[client transport] uncooperative late marker success after external abort is not audited', async () => {
    const release = gate(), started = gate();
    const h = harness({ markerGates: [release],
      dispatchNotice: (target) => { if (target.endsWith('/stations/markers-bulk')) started.resolve(); },
      uncooperativeLateSuccess: true });
    const controller = new AbortController();
    const pending = h.client.markersBulk([{ lat: 0, lon: 0 }], controller.signal, ctx);
    try {
      await wait(started.promise, 'real marker dispatch');
      expect(h.markerCalls).toBe(1);
      controller.abort();
      release.resolve();
      const outcome = await waitResult(pending.catch((e: unknown) => e), 'aborted bulk result');
      expect(outcome).toBeInstanceOf(StatiqAbortError);
      expect(h.audit).toHaveLength(0);
    } finally {
      release.resolve();
      await waitResult(pending.catch(() => undefined), 'aborted bulk cleanup');
    }
  });

  it('[client transport] uncooperative late details success after external abort is not audited', async () => {
    const release = gate(), started = gate();
    const h = harness({ detailsGate: release,
      dispatchNotice: (target) => { if (target.endsWith('/stations/details-bulk')) started.resolve(); },
      uncooperativeLateSuccess: true });
    const controller = new AbortController();
    const pending = h.client.detailsBulk([1], controller.signal);
    try {
      await wait(started.promise, 'real details dispatch');
      expect(h.detailCalls).toBe(1);
      controller.abort();
      release.resolve();
      const outcome = await waitResult(pending.catch((e: unknown) => e), 'aborted bulk result');
      expect(outcome).toBeInstanceOf(StatiqAbortError);
      expect(h.audit).toHaveLength(0);
    } finally {
      release.resolve();
      await waitResult(pending.catch(() => undefined), 'aborted bulk cleanup');
    }
  });

  it('[planner] external cancellation during bulk markers freezes sample coverage', async () => {
    const release = gate(), started = gate();
    const h = harness({ markerGates: [release],
      dispatchNotice: (target) => { if (target.endsWith('/stations/markers-bulk')) started.resolve(); },
      uncooperativeLateSuccess: true });
    const controller = new AbortController();
    const pending = planTrip({ router: h.router, statiq: cancellable(h.client, controller.signal) },
      O, D(200), OPTS).catch((e: unknown) => e);
    try {
      await wait(started.promise, 'planner bulk marker dispatch');
      expect(h.markerCalls).toBe(1);
      controller.abort();
      release.resolve();
      const message = messageOf(await waitResult(pending, 'planner cancellation result'));
      expect(message).toContain('not determined');
      expect(message).toContain('route samples covered 0/');
      expect(h.markerCalls).toBe(1);
      expect(h.audit).toHaveLength(0);
    } finally {
      release.resolve();
      await waitResult(pending.catch(() => undefined), 'aborted bulk cleanup');
    }
  });

  it('[planner] external cancellation during bulk details freezes candidate progress', async () => {
    const release = gate(), started = gate();
    const h = harness({ detailsGate: release,
      dispatchNotice: (target) => { if (target.endsWith('/stations/details-bulk')) started.resolve(); },
      uncooperativeLateSuccess: true });
    const controller = new AbortController();
    const pending = planTrip({ router: h.router, statiq: cancellable(h.client, controller.signal) },
      O, D(200), OPTS).catch((e: unknown) => e);
    try {
      await wait(started.promise, 'planner bulk details dispatch');
      expect(h.detailCalls).toBe(1);
      controller.abort();
      release.resolve();
      const message = messageOf(await waitResult(pending, 'planner cancellation result'));
      expect(message).toContain('not determined');
      expect(message).toContain('candidates processed 0/');
      expect(h.audit.length).toBe(18); // marker batch already audited, late detail frozen
    } finally {
      release.resolve();
      await waitResult(pending.catch(() => undefined), 'aborted bulk cleanup');
    }
  });

  it('[planner] explicit later-batch transport failure retains first 12 samples', async () => {
    const second = gate();
    const h = harness({ routeKm: 260, markerGates: [undefined, second] as Gate[],
      markerModes: ['ok', 'transport-fail'] });
    const errP = planTrip({ router: h.router, statiq: h.client }, O, D(260), OPTS).catch((e: unknown) => e);
    try {
      await wait(() => h.markerBatchCount() >= 2, 'second batch dispatch');
      expect(h.markerCalls).toBe(2);
      second.resolve();
      const message = messageOf(await waitResult(errP, 'later batch failure result'));
      expect(message).toContain('not determined');
      expect(message).toContain('11 of 23 route samples could not be scanned');
      expect(message).not.toContain('23 of 23');
      expect(h.audit.length).toBe(12); // only first batch audited
    } finally {
      second.resolve();
      await waitResult(errP.catch(() => undefined), 'later batch cleanup');
    }
  });

  it('[planner] exact 19-attempt budget settles to 19 observed attempts', async () => {
    const h = harness();
    const plan = await planTrip({ router: h.router, statiq: h.client }, O, D(200),
      { ...OPTS, runBudget: { deadlineMs: 120000, maxUpstreamCalls: 19 } });
    expect(plan.stops).toHaveLength(1);
    expect(h.audit).toHaveLength(19);
    expect(h.markerSquares).toEqual([12, 6]);
    expect(h.detailCalls).toBe(1);
  });

  it('[client transport] sequential cap refusal joins first batch and freezes counters', async () => {
    const release = gate(), started = gate();
    const h = harness({ detailsGate: release,
      dispatchNotice: (target) => { if (target.endsWith('/stations/details-bulk')) started.resolve(); } });
    const budget = new UpstreamBudget(2);
    h.client.attachRunBudget(budget);
    // detailsBulk chunks at 2. First chunk reserves 2; second chunk of the
    // SAME call is refused before dispatch (budget-exhausted), after the
    // first chunk has been joined and settled.
    const pending = h.client.detailsBulk([1, 2, 3], undefined,
      { endpointClass: 'stations/details', phase: 'details' }).catch((e: unknown) => e);
    try {
      await wait(started.promise, 'first details batch dispatch');
      expect(h.detailCalls).toBe(1);
      expect(h.audit).toHaveLength(0); // first batch still gated/unsettled
      expect(budget.attemptsMade).toBe(2); // pessimistic hold, not settled
      release.resolve();
      const outcome = await waitResult(pending, 'cap-drained detailsBulk');
      expect(outcome).toBeInstanceOf(UpstreamRunStoppedError);
      expect((outcome as UpstreamRunStoppedError).cause).toBe('budget-exhausted');
      // First chunk (ids 1,2) succeeded: 2 verified upstream attempts and
      // 2 completed attempts, then the SECOND chunk (id 3) was refused.
      expect(h.audit).toHaveLength(2);
      expect(budget.completedAttempts).toBe(2);
      expect(h.detailCalls).toBe(1); // no second dispatch
      expect(budget.attemptsMade).toBe(2);
      const frozen = { audit: h.audit.length, detailCalls: h.detailCalls, attempts: budget.attemptsMade };
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect({ audit: h.audit.length, detailCalls: h.detailCalls, attempts: budget.attemptsMade }).toEqual(frozen);
    } finally {
      release.resolve();
      await waitResult(pending.catch(() => undefined), 'cap test cleanup');
    }
  });

  it('[client transport] unknown transport latches with one dispatch and full hold', async () => {
    let bulkDispatch = 0, legacyDispatch = 0;
    const client = new StatiqClient({
      token: 'offline-only', baseUrl: 'https://worker.test/api', bulk: true, retries: 0,
      runDeadlineAt: Date.now() + 60_000,
      fetchImpl: (async (url: any) => {
        const target = String(url);
        if (target.endsWith('/stations/markers-bulk')) {
          bulkDispatch++;
          throw new Error('transport down');
        }
        legacyDispatch++;
        return new Response('{}');
      }) as typeof fetch,
    });
    const budget = new UpstreamBudget(20);
    client.attachRunBudget(budget);
    const first = await waitResult(
      client.markersBulk([{ lat: 28.6, lon: 77.2 }], undefined, ctx).catch((e: unknown) => e),
      'initial latch-free dispatch');
    expect(first).toBeInstanceOf(Error);
    expect((first as Error).message).toBe('transport down'); // initial wire error
    expect(bulkDispatch).toBe(1);
    expect(budget.attemptsMade).toBe(1);
    const second = await waitResult(
      client.markersBulk([{ lat: 28.7, lon: 77.3 }], undefined, ctx).catch((e: unknown) => e),
      'latched bulk call');
    expect(second).toBeInstanceOf(Error);
    expect(second).toBe(first); // same latched error object, not a new wire attempt
    expect((second as Error).message).toBe('transport down');
    expect(bulkDispatch).toBe(1); // latched: no second dispatch
    expect(budget.attemptsMade).toBe(1);
    const legacy = await waitResult(
      client.markers(1, 1).catch((e: unknown) => e), 'latched legacy call');
    expect(legacy).toBe(first); // latch also refuses legacy, no fallback
    expect(legacyDispatch).toBe(0);
  });

  it('[client transport] one active batch refuses a concurrent second batch', async () => {
    const release = gate(), started = gate();
    const h = harness({ markerGates: [release],
      dispatchNotice: (target) => { if (target.endsWith('/stations/markers-bulk')) started.resolve(); } });
    const first = h.client.markersBulk([{ lat: 0, lon: 0 }], undefined, ctx);
    try {
      await wait(started.promise, 'first marker dispatch');
      await expect(h.client.markersBulk([{ lat: 1, lon: 1 }], undefined, ctx)).rejects.toBeInstanceOf(StatiqAbortError);
      expect(h.markerCalls).toBe(1);
    } finally {
      release.resolve();
      await waitResult(first.catch(() => undefined), 'single-flight first batch cleanup');
    }
  });

  it('[planner] whole-call throttle fails closed without legacy fallback', async () => {
    const h = harness({ throttleMarkers: true });
    const err = await planTrip({ router: h.router, statiq: h.client }, O, D(200), OPTS).catch((e: unknown) => e);
    expect(messageOf(err)).toContain('throttl');
    expect(h.markerCalls).toBe(1);
    expect(h.legacyCalls).toBe(0);
  });
});
