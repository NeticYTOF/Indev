/**
 * REAL StatiqClient with explicit bulk opt-in over a wire-shaped fake bulk
 * transport. Client deadline stays 60s (above the 25s safe-batch guard).
 * Cancellation at planner level uses AbortSignal.any with an external
 * controller passed through a thin wrapper (standard supported API).
 * Every gate await is bounded and every pending promise is awaited in finally.
 */
import { describe, expect, it } from 'vitest';
import { OsrmRouter } from '../src/router.js';
import { planTrip, planTripDetailed, PlanningError } from '../src/planner.js';
import { StatiqAbortError, StatiqClient, StatiqProvenanceError, type UpstreamAuditEntry } from '../src/statiq.js';
import { scanCorridor } from '../src/corridor.js';
import { UpstreamBudget, UpstreamRunStoppedError } from '../src/upstream-budget.js';
import type { ProviderCallContext } from '../src/provider-failure.js';
import { endpointRouter } from './support/road-fixture.js';

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
      // Round-mode worker emulation (live contract, 23 Nov 2026): one
      // round of <= 40 stations, capped by the request budget, resumed by
      // an opaque cursor encoding the next offset.
      const all = body.stations as Array<{ key: string; stationId: number }>;
      const offset = body.cursor ? Number(atob(body.cursor)) : 0;
      const size = Math.min(40, body.budget.maxUpstreamAttempts, all.length - offset);
      const stations = all.slice(offset, offset + size);
      const items = stations.map((s) => ({
        key: s.key, stationId: s.stationId, outcome: 'ok', reason: null,
        upstream: { attempts: 1, statuses: [200], fetchedAt: LATER },
        provenance: { sourceUrlPath: '/station/v1/details', httpStatus: 200,
          contentType: 'application/json', cacheControl: null },
        data: { source: 'Statiq station detail (live)', station: { ...station, stationId: s.stationId } },
      }));
      const end = offset + size;
      return new Response(JSON.stringify({
        ...bulkEnvelope('details-bulk', items),
        requestedItems: all.length,
        round: { offset, size },
        continuation: end < all.length
          ? { cursor: btoa(String(end)), offset: end, remainingCount: all.length - end, totalItems: all.length }
          : null,
        unprocessedCount: 0,
      }), { status: 200, headers: BULK_HEADERS });
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
  const router = endpointRouter();
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

  it('[planner] later-batch transport failure preserves confirmed progress and original cause', async () => {
    const second = gate();
    const h = harness({ routeKm: 260, markerGates: [undefined, second] as Gate[],
      markerModes: ['ok', 'transport-fail'] });
    const progress: Array<{ samplesCompleted: number; samplesPlanned: number;
      samplesOk: number; samplesFailed: number }> = [];
    const errP = planTripDetailed({ router: h.router, statiq: h.client }, O, D(260), OPTS,
      { onProgress: (p) => progress.push({ samplesCompleted: p.samplesCompleted,
        samplesPlanned: p.samplesPlanned, samplesOk: p.samplesOk,
        samplesFailed: p.samplesFailed }) }).catch((e: unknown) => e);
    try {
      await wait(() => h.markerBatchCount() >= 2, 'second batch dispatch');
      expect(h.markerCalls).toBe(2);
      second.resolve();
      const message = messageOf(await waitResult(errP, 'later batch failure result'));
      expect(message).toContain('marker batch 2 failed');
      expect(message).not.toContain('route samples could not be scanned');
      expect(progress.at(-1)).toMatchObject({ samplesCompleted: 12, samplesPlanned: 23,
        samplesOk: 12, samplesFailed: 0 });
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
    const budget = new UpstreamBudget(25);
    h.client.attachRunBudget(budget);
    // detailsBulk sends one 26-station series. The first round reserves the
    // whole remaining budget (25); the worker answers 25 plus a cursor and
    // the next round of the SAME call is refused before dispatch
    // (budget-exhausted), after the first round has been joined and settled.
    const ids = Array.from({ length: 26 }, (_, i) => i + 1);
    const pending = h.client.detailsBulk(ids, undefined,
      { endpointClass: 'stations/details', phase: 'details' }).catch((e: unknown) => e);
    try {
      await wait(started.promise, 'first details batch dispatch');
      expect(h.detailCalls).toBe(1);
      expect(h.audit).toHaveLength(0); // first batch still gated/unsettled
      expect(budget.attemptsMade).toBe(25); // pessimistic hold, not settled
      release.resolve();
      const outcome = await waitResult(pending, 'cap-drained detailsBulk');
      expect(outcome).toBeInstanceOf(UpstreamRunStoppedError);
      expect((outcome as UpstreamRunStoppedError).cause).toBe('budget-exhausted');
      // First chunk (ids 1..25) succeeded: 25 verified upstream attempts,
      // then the SECOND chunk (id 26) was refused.
      expect(h.audit).toHaveLength(25);
      expect(budget.completedAttempts).toBe(25);
      expect(h.detailCalls).toBe(1); // no second dispatch
      expect(budget.attemptsMade).toBe(25);
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

  it('[client transport] full bulk lanes refuse one more concurrent batch', async () => {
    const release = gate();
    let dispatched = 0;
    const allStarted = gate();
    const h = harness({ markerGates: [release, release, release, release],
      dispatchNotice: (target) => {
        if (target.endsWith('/stations/markers-bulk') && ++dispatched === 3) allStarted.resolve();
      } });
    // Three single-sample calls occupy all three lanes; a fourth is refused.
    const held = [0, 1, 2].map((k) => h.client.markersBulk([{ lat: k, lon: 0 }], undefined, ctx));
    try {
      await wait(allStarted.promise, 'three marker lanes dispatched');
      await expect(h.client.markersBulk([{ lat: 9, lon: 9 }], undefined, ctx)).rejects.toBeInstanceOf(StatiqAbortError);
      expect(h.markerCalls).toBe(3);
    } finally {
      release.resolve();
      await waitResult(Promise.all(held.map((p) => p.catch(() => undefined))), 'lane cleanup');
    }
  });

  it('[client transport] probes one batch, then fans out over three lanes in order', async () => {
    const h = harness();
    const points = Array.from({ length: 12 * 7 }, (_, i) => ({ lat: i / 100, lon: 0 }));
    const order: number[] = [];
    const results = await h.client.markersBulk(points, undefined, ctx, (_r, index) => { order.push(index); });
    expect(results).toHaveLength(points.length);
    expect(order).toEqual(points.map((_, i) => i)); // strictly ordered delivery
    expect(h.markerSquares).toEqual([12, 12, 12, 12, 12, 12, 12]);
  });

  it('[client transport] keeps at most three batches in flight after the probe', async () => {
    const probe = gate(); probe.resolve();
    const slow = gate();
    const h = harness({ markerGates: [probe, slow, slow, slow, slow, slow, slow] });
    const points = Array.from({ length: 12 * 7 }, (_, i) => ({ lat: i / 100, lon: 0 }));
    const pending = h.client.markersBulk(points, undefined, ctx);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(h.markerCalls).toBe(4); // verified probe + exactly three lanes in flight
    slow.resolve();
    expect(await waitResult(pending, 'lane fan-out')).toHaveLength(points.length);
    expect(h.markerCalls).toBe(7);
  });

  it('[planner] whole-call throttle fails closed without legacy fallback', async () => {
    const h = harness({ throttleMarkers: true });
    const err = await planTrip({ router: h.router, statiq: h.client }, O, D(200), OPTS).catch((e: unknown) => e);
    expect(messageOf(err)).toContain('throttl');
    expect(h.markerCalls).toBe(1);
    expect(h.legacyCalls).toBe(0);
  });

  it('[planner] terminal snapshot exposes unconfirmed bulk holds distinctly', async () => {
    const h = harness({ throttleMarkers: true });
    const err = await planTrip({ router: h.router, statiq: h.client }, O, D(200), OPTS)
      .catch((e: unknown) => e);
    const pe = err as PlanningError;
    expect(pe.code).toBe('not_determined');
    expect(pe.cause).toBe('throttled');
    const cov = pe.coverage!;
    expect(cov.unconfirmedReservations).toBeGreaterThan(0);
    expect(cov.observedAttempts).toBeLessThan(cov.maxAttempts);
    expect(cov.candidateInventoryComplete).toBe(false);
    expect(cov.candidatesPlanned).toBe(0);
    expect(cov.samplesPlanned).toBeGreaterThan(0);
    expect('plan' in pe).toBe(false);
  });
});

describe('whole-bulk contract propagation', () => {
  const bulkRoute = [{ lat: 0, lon: 0 }, { lat: 200 / KM_PER_DEG, lon: 0 }];

  it('unwinds a bad first envelope without synthetic completed samples', async () => {
    const h = harness({ markerModes: ['bad-envelope'] });
    const progress: Array<{ completed: number; planned: number }> = [];
    const err = await scanCorridor(h.client, bulkRoute, {
      stepKm: 12, onProgress: (p) => progress.push(p),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StatiqProvenanceError);
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ completed: 0 });
    expect(progress[0]!.planned).toBeGreaterThan(0);
    expect(h.markerCalls).toBe(1);
    expect(h.detailCalls).toBe(0);
  });

  it('preserves earlier completed progress when a later envelope fails', async () => {
    const h = harness({ markerModes: ['ok', 'bad-envelope'] });
    const progress: Array<{ completed: number; planned: number }> = [];
    const err = await scanCorridor(h.client, bulkRoute, {
      stepKm: 12, onProgress: (p) => progress.push(p),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StatiqProvenanceError);
    expect(h.markerCalls).toBe(2);
    expect(progress.at(-1)!.completed).toBeGreaterThan(0);
    expect(progress.at(-1)!.completed).toBeLessThan(progress.at(-1)!.planned);
    expect(h.detailCalls).toBe(0);
  });

  it('keeps verified per-item unknown outcomes as honest holes', async () => {
    const goodMarker = { stationId: 1, name: 'Fixture', lat: 150 / KM_PER_DEG, lon: 0,
      address: null, accessType: 1, isCommunityListed: false, stationUrl: '' };
    const items = [
      { outcome: 'ok', reason: null, response: { ok: true, live: true, retained: false,
        source: 'synthetic-test', count: 1, stations: [goodMarker] } },
      { outcome: 'unknown', reason: 'upstream_timeout', response: undefined },
    ];
    const client = { markersBulk: async (_points: unknown, _signal: unknown, _context: unknown,
      onItem?: (item: unknown, index: number) => void) => {
      items.forEach((item, i) => onItem?.(item, i));
      return items;
    } } as never;
    const result = await scanCorridor(client, bulkRoute, { stepKm: 100 });
    expect(result.candidates.map((c) => c.stationId)).toEqual([1]);
    expect(result.failedSamples.length).toBeGreaterThan(0);
    expect(result.samples).toBeGreaterThan(0);
  });
});
