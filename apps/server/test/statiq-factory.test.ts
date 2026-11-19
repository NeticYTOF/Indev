/**
 * Production factory wiring regressions (behavioural, not helper-only).
 *
 * Independent config-review finding: the boot factory ignored the retries
 * opt forwarded from createApp and hardcoded the Retry-After fail-fast
 * deadline to the source-code default - so /api/health reported an
 * overridden budget the client never used. These tests drive the BUILT
 * client through the production factory (fake clock + injectable
 * transport) and prove both wirings BEHAVIOURALLY:
 *
 * - the deadline: a Retry-After larger than the EFFECTIVE budget fails fast
 *   (exactly one dispatch, zero wait consumed); a demand that FITS sleeps
 *   and re-dispatches - proving the comparison reads the wired deadline;
 * - the retries opt: forwarded when present (0 = exactly one dispatch on a
 *   persistent 500), and absent = the client's own default (2 retries =
 *   exactly three dispatches);
 * - the sanitized audit observer: wired per attempt, one entry per dispatch.
 */
import { describe, expect, it } from 'vitest';
import { StatiqApiError, type UpstreamAuditEntry } from '@indeev/core';
import { buildStatiqFactory } from '../src/statiq-factory.js';

interface StubResponse {
  status: number;
  body?: string;
  retryAfter?: string;
}

function harness(deadlineMs: number): {
  clock: { nowMs: () => number };
  factory: ReturnType<typeof buildStatiqFactory>;
  calls: Array<{ url: string; status: number; retryAfter?: string }>;
  audit: UpstreamAuditEntry[];
  respondWith: (fn: (callIndex: number) => StubResponse) => void;
} {
  let nowMs = 0;
  const clock = {
    now: () => nowMs,
    sleepImpl: async (ms: number) => {
      nowMs += Math.max(0, ms);
    },
  };
  const calls: Array<{ url: string; status: number; retryAfter?: string }> = [];
  const audit: UpstreamAuditEntry[] = [];
  const script: { fn: (callIndex: number) => StubResponse } = {
    fn: () => ({ status: 200 }),
  };
  const impl = (async (url: unknown, _init?: RequestInit): Promise<Response> => {
    const r = script.fn(calls.length);
    calls.push({ url: String(url), status: r.status, retryAfter: r.retryAfter });
    const headers = new Headers(r.retryAfter ? { 'Retry-After': r.retryAfter } : {});
    return new Response(r.body ?? '{"ok":true}', { status: r.status, headers });
  }) as typeof fetch;
  const factory = buildStatiqFactory({
    token: 'factory-test',
    deadlineMs,
    now: clock.now,
    sleepImpl: clock.sleepImpl,
    fetchImpl: impl,
    onUpstreamCall: (entry) => audit.push(entry),
  });
  return {
    clock: { nowMs: () => nowMs },
    factory,
    calls,
    audit,
    respondWith: (fn) => {
      script.fn = fn;
    },
  };
}

describe('production StatiqClient factory wiring (config-review repair)', () => {
  it('wires the EFFECTIVE deadline: a Retry-After beyond it fails fast (1 dispatch, no wait)', async () => {
    // effective budget 5s; the upstream demands 60s. Against the mis-wired
    // 4-minute default the client would sleep and re-dispatch (2+ calls) -
    // against the effective wiring it fails fast after exactly the first
    // dispatch, consuming zero wait.
    const h = harness(5_000);
    h.respondWith(() => ({
      status: 429,
      body: '{"error":"Please wait a minute."}',
      retryAfter: '60',
    }));
    // no budget attached: the fail-fast comparison is client-level wiring
    const client = h.factory();
    const err = await client.markers(1, 1).catch((e) => e);
    expect(err).toBeInstanceOf(StatiqApiError);
    expect((err as StatiqApiError).status).toBe(429); // the original 429 is rethrown
    expect(h.calls).toHaveLength(1); // fail-fast: NO sleep-retry dispatch
    expect(h.clock.nowMs()).toBe(0); // the 60s wait was never consumed
    expect(h.audit).toHaveLength(1); // the audit observer is wired per attempt
    expect(h.audit[0]?.status).toBe(429);
  });

  it('a Retry-After that FITS the effective deadline retries (negative control)', async () => {
    // a 2s demand against a 4-minute effective budget: the client sleeps
    // (fake clock) and re-dispatches - proving the comparison reads the
    // WIRED deadline, not a constant (the 5s wiring above fails fast on
    // the same demand shape)
    const h = harness(4 * 60_000);
    h.respondWith((i) =>
      i === 0 ? { status: 429, body: '{"error":"wait"}', retryAfter: '2' } : { status: 200 },
    );
    const client = h.factory();
    const res = await client.markers(1, 1);
    expect(res.ok).toBe(true);
    expect(h.calls).toHaveLength(2); // slept (fits) then re-dispatched once
    expect(h.clock.nowMs()).toBeGreaterThanOrEqual(2_000); // the wait was honored
  });

  it('forwards the explicit retries override (0 = exactly one dispatch on a persistent 500)', async () => {
    // the INDEV_PLAN_RETRIES=0 acceptance shape: exact call accounting
    const h = harness(4 * 60_000);
    h.respondWith(() => ({ status: 500, body: '{"error":"boom"}' }));
    const client = h.factory({ retries: 0 });
    const err = await client.details(7).catch((e) => e);
    expect(err).toBeInstanceOf(StatiqApiError);
    expect((err as StatiqApiError).status).toBe(500);
    expect(h.calls).toHaveLength(1); // no retries: the override was forwarded
  });

  it('absent opts preserve the client default retries (2): persistent 500 = exactly 3 dispatches', async () => {
    const h = harness(4 * 60_000);
    h.respondWith(() => ({ status: 500, body: '{"error":"boom"}' }));
    const client = h.factory(); // no opts: the client's own default applies
    const err = await client.details(7).catch((e) => e);
    expect(err).toBeInstanceOf(StatiqApiError);
    expect((err as StatiqApiError).status).toBe(500);
    expect(h.calls).toHaveLength(3); // initial + 2 default retries
    expect(h.audit).toHaveLength(3); // one sanitized entry per dispatch
  });
});
