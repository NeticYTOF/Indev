/**
 * Production StatiqClient factory: one fresh client per planning run
 * (single-run memo policy), wired from the launch's EFFECTIVE budget.
 *
 * WIRING CONTRACT (independent config-review finding): the client's
 * Retry-After fail-fast deadline and the per-launch retries override must
 * come from the SAME effective configuration the app and /api/health
 * report. A client fixed to the source-code default silently ignored
 * explicit operator overrides even while health reported them - the exact
 * production wiring gap that blocked live acceptance.
 *
 * Behavioural regression: apps/server/test/statiq-factory.test.ts drives
 * the BUILT client (not this helper in isolation) - the deadline wiring is
 * proven via the Retry-After fail-fast dispatch count, and the retries
 * forwarding via transport dispatch counts - under a fake clock.
 */
import { StatiqClient, type UpstreamAuditEntry } from '@indeev/core';

export interface StatiqFactoryConfig {
  /** Bearer token (server-side only; never logged). */
  token: string;
  /**
   * The launch's EFFECTIVE planning deadline, ms. Wired into every built
   * client as its Retry-After fail-fast bound - the same figure
   * /api/health reports, never the source-code default.
   */
  deadlineMs: number;
  /**
   * Injectable clock (tests). Used for BOTH the fail-fast bound and the
   * built client's own clock so the two can never disagree. Default: real
   * time. Absent in production wiring - behavior identical to before.
   */
  now?: () => number;
  /** Injectable sleep (tests) for deterministic transport timing. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injectable transport (tests) for behavioural wiring regressions.
   *  Production leaves it absent: the real fetch is used, byte-identical. */
  fetchImpl?: typeof fetch;
  /** Sanitized per-attempt audit: endpoint + status + time + count only. */
  onUpstreamCall?: (entry: UpstreamAuditEntry) => void;
}

/** The AppDeps.createStatiq signature (an opts-carrying factory). */
export type CreateStatiq = (opts?: { retries?: number }) => StatiqClient;

export function buildStatiqFactory(config: StatiqFactoryConfig): CreateStatiq {
  return (opts) => {
    const clock = config.now ?? Date.now;
    return new StatiqClient({
      token: config.token,
      // EFFECTIVE deadline, not the source-code default. The injectable
      // clock keeps the bound and the client's own timing consistent under
      // tests; production defaults to real time exactly as before.
      runDeadlineAt: clock() + config.deadlineMs,
      // Per-launch explicit override forwarded through the factory opts;
      // absent = undefined = the client's own default (2) - absent
      // defaults are preserved byte-identically.
      retries: opts?.retries,
      ...(config.now ? { now: config.now } : {}),
      ...(config.sleepImpl ? { sleepImpl: config.sleepImpl } : {}),
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
      ...(config.onUpstreamCall ? { onUpstreamCall: config.onUpstreamCall } : {}),
    });
  };
}
