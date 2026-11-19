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
import { StatiqClient, StatiqRunFatalError } from '../src/statiq.js';
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
    expect(budget.stopped).toBe('budget-exhausted');
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
    const { client, transportTimes } = budgetedClient({ maxAttempts: 1 });
    await client.markers(1, 1); // consumes the only attempt
    expect(transportTimes).toHaveLength(1);
    const err = await client.markers(2, 2).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamRunStoppedError);
    expect((err as UpstreamRunStoppedError).cause).toBe('budget-exhausted');
    expect(transportTimes).toHaveLength(1); // NO second transport departed
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
