/**
 * Run-budget enforcement in the StatiqClient (fake transport + fake clock).
 *
 * Invariants under an attached UpstreamBudget (planning runs):
 * - every ACTUAL transport attempt counts, including in-client 5xx retries;
 * - the cap is enforced BEFORE dispatch (no request may slip past it);
 * - the FIRST 429 / 401 / 403 stops the whole run: no sleep-then-retry,
 *   no further traffic from any concurrent worker (they fail fast at the
 *   budget gate without touching the network);
 * - Retry-After is parsed in BOTH forms (delay-seconds and HTTP-date)
 *   and recorded for honest reporting.
 */
import { describe, expect, it } from 'vitest';
import {
  StatiqAbortError,
  StatiqApiError,
  StatiqClient,
  StatiqRunFatalError,
} from '../src/statiq.js';
import { UpstreamBudget, UpstreamRunStoppedError } from '../src/upstream-budget.js';
import type { StatiqMarkersResponse } from '../src/types.js';

const emptyMarkers: StatiqMarkersResponse = {
  ok: true,
  live: true,
  retained: false,
  source: 't',
  count: 0,
  stations: [],
};

interface Responded {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/**
 * Deterministic harness: fake clock advances only inside sleepImpl, the
 * transport records its dispatch time, and the client carries a run budget.
 */
function budgetedClient(opts: {
  maxAttempts: number;
  retries?: number;
  minCallGapMs?: number;
  maxCallsPerMinute?: number;
  nowBase?: number;
  respond?: (call: { n: number }) => Responded;
}) {
  let nowMs = opts.nowBase ?? 0;
  const transportTimes: number[] = [];
  let n = 0;
  const transport = (async () => {
    const index = n++;
    transportTimes.push(nowMs);
    const r = opts.respond?.({ n: index }) ?? { status: 200 };
    const body = r.body ?? JSON.stringify(emptyMarkers);
    return new Response(body, { status: r.status, headers: new Headers(r.headers ?? {}) });
  }) as typeof fetch;
  const client = new StatiqClient({
    token: 't',
    baseUrl: 'https://x.test/api',
    fetchImpl: transport,
    now: () => nowMs,
    sleepImpl: async (ms: number) => {
      nowMs += Math.max(0, ms); // sleeping advances the fake clock deterministically
    },
    retries: opts.retries ?? 0,
    minCallGapMs: opts.minCallGapMs ?? 1,
    maxCallsPerMinute: opts.maxCallsPerMinute ?? 1_000,
  });
  const budget = new UpstreamBudget(opts.maxAttempts);
  client.attachRunBudget(budget);
  return { client, budget, transportTimes, now: () => nowMs };
}

describe('UpstreamBudget enforcement in the client (mocked transport + clock)', () => {
  it('counts every transport attempt including 5xx retries against the cap', async () => {
    // two 500s fit inside the budget; the third try is refused pre-dispatch
    const { client, budget, transportTimes } = budgetedClient({
      maxAttempts: 2,
      retries: 2,
      respond: () => ({ status: 500, body: '{"error":"boom"}' }),
    });
    const err = await client.markers(1, 1).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamRunStoppedError);
    expect((err as UpstreamRunStoppedError).cause).toBe('budget-exhausted');
    expect(transportTimes).toHaveLength(2); // initial + 1 retry dispatched; 3rd refused
    expect(budget.attemptsMade).toBe(2);
    // exhaustion is PER-CALLER: it never poisons shared (fatal) state
    expect(budget.exhausted).toBe(true);
    expect(budget.stopped).toBeNull();
  });

  it('retries that fit inside the budget still succeed', async () => {
    const { client, budget, transportTimes } = budgetedClient({
      maxAttempts: 2,
      retries: 1,
      respond: ({ n }) => (n === 0 ? { status: 502, body: '{"error":"gateway"}' } : { status: 200 }),
    });
    await client.markers(1, 1);
    expect(transportTimes).toHaveLength(2);
    expect(budget.attemptsMade).toBe(2);
    expect(budget.stopped).toBeNull();
  });

  it('refuses further dispatch the moment the cap is reached', async () => {
    const { client, budget, transportTimes } = budgetedClient({ maxAttempts: 1 });
    await client.markers(1, 1); // consumes the only attempt
    expect(transportTimes).toHaveLength(1);
    const err = await client.markers(2, 2).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamRunStoppedError);
    expect((err as UpstreamRunStoppedError).cause).toBe('budget-exhausted');
    expect(transportTimes).toHaveLength(1); // NO second transport departed
    expect(budget.attemptsMade).toBe(1); // counters match real dispatch
    expect(budget.stopped).toBeNull(); // the refusal was per-caller, not fatal
  });

  it('stops the whole run on the first 429: no sleep-retry, no further traffic', async () => {
    const { client, budget, transportTimes, now } = budgetedClient({
      maxAttempts: 10,
      respond: ({ n }) =>
        n === 0
          ? { status: 429, body: '{"error":"Please wait a minute."}', headers: { 'Retry-After': '30' } }
          : { status: 200 },
    });
    const err = await client.markers(1, 1).catch((e) => e);
    expect(err).toBeInstanceOf(StatiqRunFatalError);
    expect((err as StatiqRunFatalError).stopCause).toBe('throttled');
    expect((err as StatiqRunFatalError).retryAfterMs).toBe(30_000);
    expect(budget.stopped).toBe('throttled');
    expect(budget.retryAfterMs).toBe(30_000);
    // honored by NOT retrying: the clock never advanced into a Retry-After sleep
    expect(transportTimes).toHaveLength(1);
    expect(now()).toBe(0);
    // every later call fails fast without transport
    await expect(client.markers(2, 2)).rejects.toBeInstanceOf(UpstreamRunStoppedError);
    await expect(client.detailsWithMeta(7)).rejects.toBeInstanceOf(UpstreamRunStoppedError);
    expect(transportTimes).toHaveLength(1);
  });

  it('concurrent workers fail fast after a throttle: only one transport departs', async () => {
    // minCallGapMs 2000 => workers 2..4 sit in 10 abort-poll sleep chunks at
    // the limiter while worker 1's 429 is processed (~3 microtask hops), so
    // the budget is stopped deterministically before worker 2 could dispatch.
    const { client, budget, transportTimes } = budgetedClient({
      maxAttempts: 10,
      minCallGapMs: 2_000,
      respond: ({ n }) =>
        n === 0
          ? { status: 429, body: '{"error":"wait"}', headers: { 'Retry-After': '1' } }
          : { status: 200 },
    });
    const results = await Promise.allSettled([
      client.markers(1, 1),
      client.markers(2, 2),
      client.markers(3, 3),
      client.markers(4, 4),
    ]);
    expect(transportTimes).toHaveLength(1); // exactly one request reached the wire
    expect(budget.stopped).toBe('throttled');
    for (const r of results) {
      expect(r.status).toBe('rejected');
      const reason = (r as PromiseRejectedResult).reason as Error;
      expect(
        reason instanceof StatiqRunFatalError || reason instanceof UpstreamRunStoppedError,
      ).toBe(true);
    }
  });

  it('stops the run on the first 401/403 (auth) with no retry', async () => {
    const { client, budget, transportTimes } = budgetedClient({
      maxAttempts: 10,
      retries: 2,
      respond: ({ n }) => (n === 0 ? { status: 403, body: 'forbidden' } : { status: 200 }),
    });
    const err = await client.markers(1, 1).catch((e) => e);
    expect(err).toBeInstanceOf(StatiqRunFatalError);
    expect((err as StatiqRunFatalError).stopCause).toBe('auth');
    expect(transportTimes).toHaveLength(1); // 4xx never retried
    expect(budget.stopped).toBe('auth');
    await expect(client.markers(2, 2)).rejects.toBeInstanceOf(UpstreamRunStoppedError);
    expect(transportTimes).toHaveLength(1);
  });

  it('parses the HTTP-date form of Retry-After against the client clock', async () => {
    const BASE = Date.UTC(2026, 10, 19, 12, 0, 0); // 2026-11-19T12:00:00Z
    const { client, budget } = budgetedClient({
      maxAttempts: 5,
      nowBase: BASE,
      respond: ({ n }) =>
        n === 0
          ? { status: 429, body: 'wait', headers: { 'Retry-After': new Date(BASE + 60_000).toUTCString() } }
          : { status: 200 },
    });
    const err = await client.markers(1, 1).catch((e) => e);
    expect(err).toBeInstanceOf(StatiqRunFatalError);
    expect((err as StatiqRunFatalError).retryAfterMs).toBe(60_000);
    expect(budget.retryAfterMs).toBe(60_000); // 60s in the future -> 60000ms
  });

  it('clamps a past HTTP-date Retry-After to 0 (allowed immediately later)', async () => {
    const BASE = Date.UTC(2026, 10, 19, 12, 0, 0);
    const { client, budget } = budgetedClient({
      maxAttempts: 5,
      nowBase: BASE,
      respond: ({ n }) =>
        n === 0
          ? { status: 429, body: 'wait', headers: { 'Retry-After': new Date(BASE - 30_000).toUTCString() } }
          : { status: 200 },
    });
    const err = await client.markers(1, 1).catch((e) => e);
    expect(err).toBeInstanceOf(StatiqRunFatalError);
    expect(budget.stopped).toBe('throttled');
    expect(budget.retryAfterMs).toBe(0); // date already past -> no demanded wait
  });

  it('legacy no-budget clients keep the honor-Retry-After retry path', async () => {
    let n = 0;
    let nowMs = 0;
    const transportTimes: number[] = [];
    const transport = (async () => {
      const index = n++;
      transportTimes.push(nowMs);
      if (index === 0) {
        return new Response('{"error":"wait"}', { status: 429, headers: { 'Retry-After': '1' } });
      }
      return new Response(JSON.stringify(emptyMarkers), { status: 200 });
    }) as typeof fetch;
    const client = new StatiqClient({
      token: 't',
      baseUrl: 'https://x.test/api',
      fetchImpl: transport,
      now: () => nowMs,
      sleepImpl: async (ms: number) => {
        nowMs += ms;
      },
      retries: 2,
      minCallGapMs: 1,
      maxCallsPerMinute: 1_000,
    });
    await client.markers(1, 1); // retries once, honoring the 1s Retry-After
    expect(transportTimes).toHaveLength(2);
    expect((transportTimes[1] as number) - (transportTimes[0] as number)).toBeGreaterThanOrEqual(1_000);
  });
});

/**
 * RESERVATION-RACE REGRESSIONS (dispatch-accounting correctness).
 *
 * Historical bug (found by the Linux verifier's repro at 2356a09):
 * reservations happened BEFORE the paced permit (backoff/acquireSlot),
 * and cap exhaustion was stored as a run-fatal stop - so N>cap concurrent
 * callers globally stopped the run BEFORE anyone dispatched: actual
 * network 0 while attemptsMade reported reserved-but-undelivered work,
 * and every caller rejected (valid reserved work retroactively cancelled).
 *
 * Required invariants (no independent auth/throttle/deadline involved):
 * - exactly `cap` dispatches happen; reserved counters match REAL dispatch;
 * - callers holding reservations complete their work (fulfilled), only
 *   the callers finding no room reject with budget-exhausted;
 * - exhaustion never poisons shared state (stopped stays null).
 */
describe('reservation race: concurrent callers vs the attempt cap', () => {
  it('N>cap: exactly cap dispatch, counters match, reserved work is NOT cancelled', async () => {
    // coordinator repro shape: 4 concurrent callers, budget 2
    const { client, budget, transportTimes } = budgetedClient({ maxAttempts: 2 });
    const results = await Promise.allSettled([
      client.markers(1, 1),
      client.markers(2, 2),
      client.markers(3, 3),
      client.markers(4, 4),
    ]);
    // dispatch-accounting: exactly the cap reached the wire, and the
    // budget counters count REAL dispatches (reserved == dispatched)
    expect(transportTimes).toHaveLength(2);
    expect(budget.attemptsMade).toBe(2);
    expect(budget.exhausted).toBe(true);
    // exhaustion is per-caller: the shared state stays non-fatal
    expect(budget.stopped).toBeNull();
    // two callers fulfilled - their reserved work was NOT retroactively
    // cancelled by the other two finding the cap exhausted (old bug: 0)
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason as UpstreamRunStoppedError;
      expect(reason).toBeInstanceOf(UpstreamRunStoppedError);
      expect(reason.cause).toBe('budget-exhausted');
    }
  });

  it('budget 1 with 3 concurrent callers: exactly 1 dispatch, 1 fulfilled', async () => {
    // the budget-1 shape of the repro (old behavior: actual 0, reported 1)
    const { client, budget, transportTimes } = budgetedClient({ maxAttempts: 1 });
    const results = await Promise.allSettled([
      client.markers(1, 1),
      client.markers(2, 2),
      client.markers(3, 3),
    ]);
    expect(transportTimes).toHaveLength(1);
    expect(budget.attemptsMade).toBe(1); // counters match real dispatch
    expect(budget.exhausted).toBe(true);
    expect(budget.stopped).toBeNull();
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
  });

  it('N == cap: every caller dispatches and fulfills', async () => {
    const { client, budget, transportTimes } = budgetedClient({ maxAttempts: 3 });
    const results = await Promise.allSettled([
      client.markers(1, 1),
      client.markers(2, 2),
      client.markers(3, 3),
    ]);
    expect(transportTimes).toHaveLength(3);
    expect(budget.attemptsMade).toBe(3);
    expect(budget.exhausted).toBe(true);
    expect(budget.stopped).toBeNull();
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('fatal stops remain global: zero new dispatch after a concurrent 429', async () => {
    // the reservation split must NOT weaken the fatal-stop invariant:
    // after a throttle response, concurrent waiters fail fast at the
    // reservation recheck without touching the network
    const { client, budget, transportTimes } = budgetedClient({
      maxAttempts: 10,
      minCallGapMs: 2_000,
      respond: ({ n }) =>
        n === 0
          ? { status: 429, body: '{"error":"wait"}', headers: { 'Retry-After': '1' } }
          : { status: 200 },
    });
    const results = await Promise.allSettled([
      client.markers(1, 1),
      client.markers(2, 2),
      client.markers(3, 3),
      client.markers(4, 4),
    ]);
    expect(transportTimes).toHaveLength(1); // only the throttled dispatch
    expect(budget.stopped).toBe('throttled');
    expect(budget.attemptsMade).toBe(1); // reserved == dispatched here too
    for (const r of results) {
      expect(r.status).toBe('rejected');
      const reason = (r as PromiseRejectedResult).reason as Error;
      expect(
        reason instanceof StatiqRunFatalError || reason instanceof UpstreamRunStoppedError,
      ).toBe(true);
    }
  });
});

/**
 * COMPLETION-CONTRACT BOUNDARY: per-request timeout vs outer cancellation.
 *
 * Historical misclassification (found by boundary inspection): with an
 * outer signal attached (every budgeted planning run passes one), the
 * catch treated ANY AbortError-shaped rejection as run cancellation and
 * never retried - so the per-request 10s timeout (inner controller) killed
 * the whole planning run as a false 'deadline' report. The boundary is
 * determined by the AUTHORITATIVE signal state, not the error shape:
 *
 * - AbortError with the outer signal ALIVE = per-request timeout: reached
 *   the wire, audited status 0, counts against the budget (retries
 *   included), RETRIED like any transport failure;
 * - outer signal ABORTED (run deadline / explicit cancellation): NEVER
 *   retried, run-fatal.
 */
describe('completion contract: timeout vs cancellation', () => {
  /** The exact error shape a controller.abort() produces in Node fetch. */
  function abortShapedError(): Error {
    const e = new Error('This operation was aborted');
    e.name = 'AbortError';
    return e;
  }

  it('a per-request timeout (AbortError, outer signal LIVE) is retried, not a cancellation', async () => {
    let n = 0;
    const transportTimes: number[] = [];
    let nowMs = 0;
    const transport = (async () => {
      const index = n++;
      transportTimes.push(nowMs);
      if (index === 0) throw abortShapedError(); // the 10s timer fired
      return new Response(JSON.stringify(emptyMarkers), { status: 200 });
    }) as typeof fetch;
    const budget = new UpstreamBudget(10);
    const client = new StatiqClient({
      token: 't',
      baseUrl: 'https://x.test/api',
      fetchImpl: transport,
      now: () => nowMs,
      sleepImpl: async (ms: number) => {
        nowMs += ms;
      },
      retries: 2,
      minCallGapMs: 1,
      maxCallsPerMinute: 1_000,
    });
    client.attachRunBudget(budget);
    // a LIVE outer signal (the planning shape): must NOT make the timeout
    // look like a deadline cancellation
    const liveOuter = new AbortController();
    await client.markers(1, 1, liveOuter.signal);
    expect(n).toBe(2); // the timeout was retried
    expect(liveOuter.signal.aborted).toBe(false);
    expect(budget.attemptsMade).toBe(2); // BOTH dispatches counted (reserved == dispatched)
    expect(budget.stopped).toBeNull();
  });

  it('a timeout on the LAST allowable dispatch refuses the retry as exhaustion, not cancellation', async () => {
    let n = 0;
    let nowMs = 0; // ADVANCING fake clock: the retry's limiter wait must be
    // able to observe time passing - a constant clock + no-op sleep spins
    // acquireSlot's poll loop forever (the Linux 30s hang)
    const transport = (async () => {
      if (n++ === 0) throw abortShapedError(); // consumes the only attempt
      return new Response(JSON.stringify(emptyMarkers), { status: 200 });
    }) as typeof fetch;
    const budget = new UpstreamBudget(1);
    const client = new StatiqClient({
      token: 't',
      baseUrl: 'https://x.test/api',
      fetchImpl: transport,
      now: () => nowMs,
      sleepImpl: async (ms: number) => {
        nowMs += ms;
      },
      retries: 2,
      minCallGapMs: 1,
      maxCallsPerMinute: 1_000,
    });
    client.attachRunBudget(budget);
    const liveOuter = new AbortController();
    const err = await client.markers(1, 1, liveOuter.signal).catch((e) => e);
    // previously this misreported as a run abort (false 'deadline'); the
    // honest outcome: the attempt cap is exhausted by real dispatch work
    expect(err).toBeInstanceOf(UpstreamRunStoppedError);
    expect((err as UpstreamRunStoppedError).cause).toBe('budget-exhausted');
    expect(n).toBe(1); // the timeout DID reach the wire once
    expect(liveOuter.signal.aborted).toBe(false); // nobody cancelled the run
    expect(budget.stopped).toBeNull(); // exhaustion is not fatal either
  });

  it('retries exhausted on timeouts surface a transport-failure error, never a cancellation', async () => {
    let nowMs = 0; // advancing fake clock (same fixture discipline as above)
    const transport = (async () => {
      throw abortShapedError();
    }) as typeof fetch;
    const client = new StatiqClient({
      token: 't',
      baseUrl: 'https://x.test/api',
      fetchImpl: transport,
      now: () => nowMs,
      sleepImpl: async (ms: number) => {
        nowMs += ms;
      },
      retries: 0,
      minCallGapMs: 1,
      maxCallsPerMinute: 1_000,
    });
    const liveOuter = new AbortController();
    const err = await client.markers(1, 1, liveOuter.signal).catch((e) => e);
    expect(err).toBeInstanceOf(StatiqApiError);
    expect((err as StatiqApiError).status).toBe(0); // transport-failure shape
    expect(err).not.toBeInstanceOf(StatiqAbortError);
    expect(liveOuter.signal.aborted).toBe(false);
  });

  it('OUTER cancellation is NEVER retried, whatever the error shape', async () => {
    let n = 0;
    let nowMs = 0; // advancing fake clock (same fixture discipline as above)
    const outer = new AbortController();
    const transport = (async () => {
      n++;
      outer.abort(); // the run deadline fires while this request is in flight
      throw abortShapedError();
    }) as typeof fetch;
    const client = new StatiqClient({
      token: 't',
      baseUrl: 'https://x.test/api',
      fetchImpl: transport,
      now: () => nowMs,
      sleepImpl: async (ms: number) => {
        nowMs += ms;
      },
      retries: 2, // a retry would be WRONG here: the run is cancelled
      minCallGapMs: 1,
      maxCallsPerMinute: 1_000,
    });
    const err = await client.markers(1, 1, outer.signal).catch((e) => e);
    expect(err).toBeInstanceOf(StatiqAbortError);
    expect(n).toBe(1); // no retry after the outer cancel
  });
});

/**
 * FATAL-HEADERS RACE (contract repair; Linux offline repro raced 2/6).
 *
 * The old flow stopped the shared budget only AFTER awaiting the response
 * body - so a fatal 429 whose body resolved slowly left a window where a
 * gated concurrent worker passed the budget gate and dispatched one extra
 * request. The repaired contract:
 *
 * - the budget stops AT THE FATAL HEADERS (401/403/429), BEFORE the body;
 * - already-in-flight requests complete as legitimate work;
 * - ZERO NEW DISPATCH follows fatal headers;
 * - diagnostics are retained afterwards: the audit entry carries the true
 *   status, the error carries the body, and Retry-After parses from the
 *   headers at stop time.
 */
describe('fatal-headers race: budget stops at headers, before the body', () => {
  /** Response-like whose fetch resolves instantly (headers) but whose body
   *  resolves only after `hops` microtask turns - the repro's slow body. */
  function delayedFatalBody(hops: number): Response {
    return {
      ok: false,
      status: 429,
      headers: new Headers({ 'Retry-After': '30' }),
      async text() {
        for (let i = 0; i < hops; i++) await Promise.resolve();
        return '{"error":"Please wait a minute."}';
      },
    } as unknown as Response;
  }

  function fakeClockClient(
    transport: typeof fetch,
    maxAttempts: number,
    minCallGapMs: number,
  ): { client: StatiqClient; budget: UpstreamBudget } {
    let nowMs = 0;
    const budget = new UpstreamBudget(maxAttempts);
    const client = new StatiqClient({
      token: 't',
      baseUrl: 'https://x.test/api',
      fetchImpl: transport,
      now: () => nowMs,
      sleepImpl: async (ms: number) => {
        nowMs += ms;
      },
      retries: 0,
      minCallGapMs,
      maxCallsPerMinute: 1_000,
    });
    client.attachRunBudget(budget);
    return { client, budget };
  }

  it('a ready waiter NEVER dispatches between fatal HEADERS and the body', async () => {
    // repro shape: worker 1's fatal body takes 10 microtask hops; worker 2
    // sits one limiter wake away. Stop-at-headers refuses worker 2 at its
    // reserve; the OLD stop-after-body let it dispatch (the race).
    let n = 0;
    const transport = (async () => {
      if (n++ === 0) return delayedFatalBody(10);
      return new Response(JSON.stringify(emptyMarkers), { status: 200 });
    }) as typeof fetch;
    // gap 500 -> two 200ms poll chunks before worker 2's wake (~5 hops),
    // well after worker 1's headers/stop (~2 hops) and well before the
    // 10-hop body resolves: the ordering discriminates the repair
    const { client, budget } = fakeClockClient(transport, 10, 500);
    const results = await Promise.allSettled([
      client.markers(1, 1),
      client.markers(2, 2),
    ]);
    // exactly ONE dispatch: the fatal one - zero NEW dispatch after headers
    expect(n).toBe(1);
    expect(budget.stopped).toBe('throttled');
    expect(budget.retryAfterMs).toBe(30_000); // parsed from HEADERS at stop time
    const [r1, r2] = results as [
      PromiseSettledResult<unknown>,
      PromiseSettledResult<unknown>,
    ];
    expect(r1.status).toBe('rejected');
    expect(r1.reason).toBeInstanceOf(StatiqRunFatalError);
    // diagnostics retained: the body arrives late but travels on the error
    expect((r1.reason as StatiqRunFatalError).message).toContain('Please wait a minute');
    // the ready waiter was refused at the gate (after the headers, before
    // the body ever resolved) - hearing the stop, never the network
    expect(r2.status).toBe('rejected');
    expect((r2.reason as UpstreamRunStoppedError).cause).toBe('throttled');
  });

  it('an ALREADY-IN-FLIGHT request completes; only post-header dispatches are refused', async () => {
    // worker 1's whole FETCH is delayed 12 hops, THEN returns the fatal 429
    // (immediate body); worker 2 dispatches behind it and its 200 returns
    // BEFORE worker 1's headers land: worker 2 is legitimate in-flight
    // work and FULFILLS. The stop refuses only requests that had not yet
    // dispatched when the fatal headers arrived.
    let n = 0;
    const transport = (async () => {
      if (n++ === 0) {
        for (let i = 0; i < 12; i++) await Promise.resolve();
        return new Response('{"error":"Please wait a minute."}', {
          status: 429,
          headers: new Headers({ 'Retry-After': '30' }),
        });
      }
      return new Response(JSON.stringify(emptyMarkers), { status: 200 });
    }) as typeof fetch;
    // worker 2 dispatches ~3 hops in (1 chunk of 100 fake ms), its 200
    // resolves ~2 hops later - all well before worker 1's 12-hop headers
    const { client, budget } = fakeClockClient(transport, 10, 100);
    const results = await Promise.allSettled([
      client.markers(1, 1),
      client.markers(2, 2),
    ]);
    expect(n).toBe(2); // both dispatched - worker 2 was legitimately in flight
    expect(results[1]?.status).toBe('fulfilled');
    expect(results[0]?.status).toBe('rejected');
    const fatal = (results[0] as PromiseRejectedResult).reason as StatiqRunFatalError;
    expect(fatal).toBeInstanceOf(StatiqRunFatalError);
    expect(fatal.stopCause).toBe('throttled');
    expect(fatal.retryAfterMs).toBe(30_000);
    expect(budget.stopped).toBe('throttled');
    expect(budget.attemptsMade).toBe(2); // reserved == dispatched for both
  });
});
