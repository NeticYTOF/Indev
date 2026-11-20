import { hasFreshProvenance } from './provenance.js';
/**
 * Statiq API replica client.
 *
 * - Bearer token comes from the environment and is used ONLY here,
 *   server-side. It is never printed, logged, or included in error messages.
 * - MEMO POLICY: the in-memory details memo exists ONLY for reuse inside a
 *   single planning run (the same station can be examined twice within one
 *   plan). Callers must create a fresh client per planning run; memoized
 *   data must NEVER be presented as live status. Anything showing status
 *   carries a `fetchedAt` timestamp from `detailsWithMeta`.
 * - The rolling-window limiter spaces calls out (anti-burst) and hard-caps
 *   calls per 60s; it is abort-aware so a run deadline cancels cleanly.
 *   Its defaults (25 calls / 60s, 2s min gap) are CONSERVATIVE PROJECT
 *   SAFETY DEFAULTS - our own politeness choice, NOT a provider contract:
 *   the upstream publishes no rate-limit headers we rely on.
 * - RETRY POLICY: budgeted planning runs (see attachRunBudget) fail CLOSED
 *   on the FIRST 429/401/403 - the shared budget stops AT THE RESPONSE
 *   HEADERS, BEFORE the body resolves (a fatal status is fully known at
 *   headers; waiting for the body let a gated worker slip one extra
 *   dispatch - the Linux race repro), no sleep-then-retry, no NEW dispatch
 *   from any concurrent worker (requests already in flight complete as
 *   legitimate work), and the parsed Retry-After (delay-seconds OR
 *   HTTP-date) is recorded at stop time for honest reporting. Without a
 *   budget (single-call station revalidation) 429s are honored via the
 *   full Retry-After with capped retries.
 * - TIMEOUT vs CANCELLATION (completion-contract boundary): the per-request
 *   timeout (10s inner controller) is a RETRYABLE TRANSPORT FAILURE - it
 *   reached the wire, is audited with status 0, counts against the run
 *   budget (retries included) and is retried. Only OUTER signal aborts
 *   (run deadline / explicit cancellation) are run-fatal and never
 *   retried - detected by the authoritative signal state, not the error
 *   shape (an AbortError with a live outer signal is a timeout).
 */
import type {
  StatiqCardsResponse,
  StatiqDetailsResponse,
  StatiqMarkersResponse,
} from './types.js';
import { sleep as defaultSleep } from './utils.js';
import { UpstreamBudget, UpstreamRunStoppedError } from './upstream-budget.js';
import {
  parseGatewayFailureCode,
  parseGatewayUpstreamStatus,
  statusCodeForHttp,
  transportCodeForCause,
  type ProviderCallContext,
  type ProviderFailureCollector,
} from './provider-failure.js';

export const DEFAULT_STATIQ_BASE_URL =
  'https://harrier-evroute.aaravnirajsingh.workers.dev/api';

/**
 * How long dispatch stamps are retained by the rolling-window limiter
 * (slightly past the 60s window so boundary windows stay conservative).
 * SHARED with the work-estimate module (packages/core/src/work-estimate.ts)
 * so the limiter's effective sustained pacing and full-coverage estimates
 * can never drift apart. Linux measured the effective window at ~62.05s
 * (25 calls per 62.05s under the defaults).
 */
export const WINDOW_RETENTION_MS = 62_000;

export class StatiqApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
    readonly retryAfterMs?: number,
  ) {
    // Body text is upstream-controlled JSON; keep it short and never
    // include request headers (token safety).
    super(`Statiq API ${status} on ${path}: ${body.slice(0, 200)}`);
    this.name = 'StatiqApiError';
  }
}

export class StatiqProvenanceError extends StatiqApiError {
  constructor(path: string) {
    super(200, path, 'Fresh station provenance could not be verified');
    this.name = 'StatiqProvenanceError';
  }
}

/**
 * Run-fatal 4xx under an attached run budget (first 429/401/403).
 * Never retried; the whole planning run fails closed (the planner maps
 * this to an honest not_determined outcome with coverage evidence).
 */
export class StatiqRunFatalError extends StatiqApiError {
  constructor(
    readonly stopCause: 'throttled' | 'auth',
    status: number,
    path: string,
    body: string,
    retryAfterMs?: number,
  ) {
    super(status, path, body, retryAfterMs);
    this.name = 'StatiqRunFatalError';
  }
}

/** Raised when a call is aborted (run deadline/budget reached). Never retried. */
export class StatiqAbortError extends Error {
  constructor(message = 'Statiq call aborted (run deadline or cancellation)') {
    super(message);
    this.name = 'StatiqAbortError';
  }
}

/** True for any abort-shaped error (ours, fetch's, or DOMException). */
export function isAbortLike(err: unknown): boolean {
  return (
    err instanceof StatiqAbortError ||
    (err instanceof Error && err.name === 'AbortError') ||
    (err instanceof Error && /aborted/i.test(err.message))
  );
}

export interface StatiqClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** in-memory details cache TTL; 0 disables caching */
  cacheTtlMs?: number;
  timeoutMs?: number;
  retries?: number;
  /**
   * Rolling-window limit: max upstream calls per 60s. Default 25 is a
   * CONSERVATIVE PROJECT SAFETY DEFAULT, NOT a provider contract (the
   * upstream publishes no rate headers we rely on). Smoothed by
   * minCallGapMs below, so the budget cannot burst.
   */
  maxCallsPerMinute?: number;
  /**
   * Minimum gap between upstream calls. Default 2000ms is likewise a
   * PROJECT SAFETY DEFAULT, NOT a provider contract.
   */
  minCallGapMs?: number;
  /** Injectable clock for deterministic limiter tests. */
  now?: () => number;
  /** Injectable sleep for deterministic limiter tests. */
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * Wall-clock deadline (ms epoch) for the planning run this client serves.
   * If a 429's Retry-After cannot fit before this deadline, the call fails
   * fast with the throttled error instead of retrying early.
   */
  /**
   * Sanitized audit observer: invoked once per upstream attempt with
   * { seq, endpoint, status, at } ONLY. Never auth headers, query strings,
   * request/response bodies, coordinates or any private route data.
   */
  onUpstreamCall?: (entry: UpstreamAuditEntry) => void;
  runDeadlineAt?: number;
}

/** Strictly sanitized audit entry: endpoint name + status + time + count. */
export interface UpstreamAuditEntry {
  /** Running count of upstream attempts within this client (planning run). */
  seq: number;
  /** Endpoint path only, e.g. "stations/markers". */
  endpoint: string;
  /** HTTP status (0 = transport failure / abort). */
  status: number;
  /** ISO timestamp. */
  at: string;
}

interface CacheEntry {
  at: number;
  response: StatiqDetailsResponse;
  fetchedAt: Date;
}

export interface StationDetailsWithMeta {
  response: StatiqDetailsResponse;
  /** When this upstream response was actually fetched. */
  fetchedAt: Date;
}

export class StatiqClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly maxCallsPerMinute: number;
  private readonly minCallGapMs: number;
  private readonly now: () => number;
  private readonly doSleep: (ms: number) => Promise<void>;
  private readonly runDeadlineAt: number | undefined;
  private readonly onUpstreamCall: ((entry: UpstreamAuditEntry) => void) | undefined;
  /** Per-run bounded completion evidence; never an execution controller. */
  private failureCollector: ProviderFailureCollector | undefined;
  /** Separate from completion-order audit seq; incremented at dispatch. */
  private dispatchAttempts = 0;
  /** Shared per-run attempt budget (attached by the planner for live runs). */
  private runBudget: UpstreamBudget | undefined;
  private upstreamAttempts = 0;
  private readonly detailsCache = new Map<number, CacheEntry>();
  private lastCallAt = Number.NEGATIVE_INFINITY;
  private callStamps: number[] = [];
  /** Serializes slot acquisition so concurrent callers cannot interleave. */
  private slotQueue: Promise<void> = Promise.resolve();

  constructor(opts: StatiqClientOptions) {
    if (!opts.token) {
      throw new Error('StatiqClient requires a token (set STATIQ_API_TOKEN)');
    }
    this.base = (opts.baseUrl ?? DEFAULT_STATIQ_BASE_URL).replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.cacheTtlMs = opts.cacheTtlMs ?? 90_000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retries = opts.retries ?? 2;
    this.maxCallsPerMinute = opts.maxCallsPerMinute ?? 25;
    this.minCallGapMs = opts.minCallGapMs ?? 2_000;
    this.now = opts.now ?? Date.now;
    this.doSleep = opts.sleepImpl ?? defaultSleep;
    this.runDeadlineAt = opts.runDeadlineAt;
    this.onUpstreamCall = opts.onUpstreamCall;
  }

  /** Stations near a point (~13 km radius, capped at 256 by the upstream). */
  markers(
    lat: number,
    lon: number,
    signal?: AbortSignal,
    context?: ProviderCallContext,
  ): Promise<StatiqMarkersResponse> {
    return this.postJson('/stations/markers', { latitude: lat, longitude: lon }, signal, context);
  }

  /** Nearest station cards around a point. */
  cards(lat: number, lon: number, signal?: AbortSignal): Promise<StatiqCardsResponse> {
    return this.postJson('/stations/cards', { latitude: lat, longitude: lon }, signal);
  }

  /**
   * Full details with a fetched-at timestamp. The memo returns the original
   * fetch time (not access time) so status displays stay honest.
   */
  async detailsWithMeta(
    stationId: number,
    signal?: AbortSignal,
    context?: ProviderCallContext,
  ): Promise<StationDetailsWithMeta> {
    if (signal?.aborted) throw new StatiqAbortError();
    const cached = this.detailsCache.get(stationId);
    if (cached && this.now() - cached.at < this.cacheTtlMs) {
      if (!hasFreshProvenance(cached.response)) throw new StatiqProvenanceError('/stations/details');
      if (signal?.aborted) throw new StatiqAbortError();
      return { response: cached.response, fetchedAt: cached.fetchedAt };
    }
    const response = await this.postJson<StatiqDetailsResponse>('/stations/details', {
      station_id: stationId,
    }, signal, context);
    if (signal?.aborted) throw new StatiqAbortError();
    if (!hasFreshProvenance(response)) throw new StatiqProvenanceError('/stations/details');
    const fetchedAt = new Date();
    if (response && response.station) {
      const at = this.now();
      if (signal?.aborted) throw new StatiqAbortError();
      this.detailsCache.set(stationId, { at, response, fetchedAt });
    }
    return { response, fetchedAt };
  }

  /** Wire-shaped details (no fetch metadata). */
  async details(stationId: number, signal?: AbortSignal): Promise<StatiqDetailsResponse> {
    const result = await this.detailsWithMeta(stationId, signal);
    if (signal?.aborted) throw new StatiqAbortError();
    return result.response;
  }

  /**
   * Attach the shared per-run attempt budget. Every transport attempt
   * (retries included) reserves against it, and the first 429/401/403
   * stops the whole run fail-closed. The client is per planning run
   * (single-run memo policy); attach BEFORE the first upstream call.
   */
  attachRunBudget(budget: UpstreamBudget, collector?: ProviderFailureCollector): void {
    this.runBudget = budget;
    if (collector) this.failureCollector = collector;
  }

  /** Attach a bounded, per-run completion-only evidence collector. */
  attachFailureCollector(collector: ProviderFailureCollector): void {
    this.failureCollector = collector;
  }

  private reportFailure(
    context: ProviderCallContext | undefined,
    path: string,
    code: Parameters<ProviderFailureCollector['record']>[0]['code'],
    dispatchSeq: number | null,
    httpStatus: number | null,
    gatewayFailureCode: ReturnType<typeof parseGatewayFailureCode> = null,
    gatewayUpstreamStatus: number | null = null,
  ): void {
    const collector = this.failureCollector;
    if (!collector) return;
    try {
      const endpointClass =
        path === '/stations/markers' ? 'stations/markers' :
        path === '/stations/details' ? 'stations/details' : 'none';
      collector.record({
        endpointClass: context?.endpointClass ?? endpointClass,
        phase: context?.phase ?? (endpointClass === 'stations/markers' ? 'scan' : 'details'),
        // Details/route are null by contract; only marker context may carry ordinal.
        sampleOrdinal: endpointClass === 'stations/markers' ? context?.sampleOrdinal ?? null : null,
        dispatchSeq,
        httpStatus,
        code,
        gatewayFailureCode,
        gatewayUpstreamStatus,
      });
    } catch {
      /* Diagnostics must never alter run behavior. */
    }
  }

  /**
   * Rolling-window rate limiter. Guaranteed properties (unit-tested with
   * a mocked transport and clock):
   * - no two upstream calls closer than `minCallGapMs`
   * - never more than `maxCallsPerMinute` calls in ANY rolling 60s window
   *   (stamps are retained 62s so boundary windows stay conservative)
   * - aborts promptly when `signal` fires while waiting (poll sleeps are
   *   capped at 200ms)
   * Waiters are SERIALIZED through `slotQueue`: only one waiter evaluates
   * the gap/window state at a time, so concurrent bursts cannot interleave
   * between the check and the stamp.
   */
  private acquireSlot(signal?: AbortSignal): Promise<void> {
    const turn = this.slotQueue.then(() => this.acquireSlotLocked(signal));
    // keep the queue moving even if this waiter aborts/fails
    this.slotQueue = turn.catch(() => {});
    return turn;
  }

  private async acquireSlotLocked(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new StatiqAbortError();
      const now = this.now();
      // Retain stamps past the window: a push is only allowed when even the
      // most conservative 60s window (ending now) holds < max calls. The
      // 62s retention is shared with the work-estimate module
      // (WINDOW_RETENTION_MS) so the limiter's effective sustained pacing
      // and the estimator can never drift apart.
      this.callStamps = this.callStamps.filter((t) => now - t < WINDOW_RETENTION_MS);
      const gapWait = this.lastCallAt + this.minCallGapMs - now;
      const windowFull = this.callStamps.length >= this.maxCallsPerMinute;
      if (!windowFull && gapWait <= 0) {
        const stamp = Math.max(now, this.lastCallAt + this.minCallGapMs);
        this.callStamps.push(stamp);
        this.lastCallAt = stamp;
        return;
      }
      const oldest = this.callStamps[0] ?? now;
      const windowWait = windowFull ? WINDOW_RETENTION_MS - (now - oldest) + 50 : 0;
      // wait at most ~200ms so an abort is noticed within one poll cycle
      await this.doSleep(Math.min(Math.max(gapWait, windowWait, 50), 200));
    }
  }

  /**
   * Abort-aware sleep: polls in <=200ms chunks so a deadline abort is
   * noticed within one poll cycle - even mid Retry-After wait.
   */
  private async sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
    let remaining = Math.max(0, ms);
    for (;;) {
      if (signal?.aborted) throw new StatiqAbortError();
      if (remaining <= 0) return;
      const chunk = Math.min(remaining, 200);
      await this.doSleep(chunk);
      remaining -= chunk;
    }
  }

  /**
   * Backoff between attempts. A 429's Retry-After is honored IN FULL -
   * never truncated - plus a small jitter on top (so never earlier than
   * the server demanded). Otherwise: exponential with full jitter, capped
   * at 4s. All sleeps are abort-aware.
   */
  private async backoffMs(attempt: number, retryAfterMs: number | undefined, signal?: AbortSignal): Promise<void> {
    if (retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      await this.sleepAbortable(retryAfterMs + Math.random() * 250, signal);
      return;
    }
    const base = 250 * 2 ** Math.min(attempt, 4); // caps the exponential at 4s
    const jittered = Math.random() * base; // full jitter: 0..base
    await this.sleepAbortable(Math.min(jittered, 4_000) + 100, signal);
  }

/** Sanitized audit hook: one sanitized entry per upstream attempt. */
  private audit(endpoint: string, status: number): void {
    this.upstreamAttempts += 1;
    if (this.onUpstreamCall) {
      this.onUpstreamCall({
        seq: this.upstreamAttempts,
        endpoint: endpoint.replace(/^\/+/, ''),
        status,
        at: new Date().toISOString(),
      });
    }
  }

  /** Total upstream attempts made through this client (per run). */
  upstreamCallsMade(): number {
    return this.upstreamAttempts;
  }

  /** Dispatched attempts after successful reservation, not completions. */
  dispatchedAttemptsMade(): number {
    return this.dispatchAttempts;
  }

  private async postJson<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    context?: ProviderCallContext,
  ): Promise<T> {
    let lastError: unknown;
    let lastRetryAfterMs: number | undefined;
    let attemptEvidenceRecorded = false;
    // 1 initial attempt + `retries` retries; aborts are never retried
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        const override = lastRetryAfterMs;
        lastRetryAfterMs = undefined;
        // Never truncate the server-demanded wait: if honoring the full
        // Retry-After cannot fit inside this run's remaining deadline, fail
        // fast with the throttled error instead of retrying early.
        if (
          override != null &&
          this.runDeadlineAt != null &&
          this.now() + override > this.runDeadlineAt
        ) {
          if (lastError instanceof StatiqApiError) throw lastError;
          throw new StatiqApiError(429, path, 'throttled; Retry-After exceeds run deadline', override);
        }
        await this.backoffMs(attempt, override, signal);
      }
      // 1) Paced permit FIRST: the limiter (and any backoff above) is fully
      // awaited BEFORE any reservation - no up-front reservation can be
      // cancelled by another waiter finding the cap exhausted.
      try {
        await this.acquireSlot(signal);
      } catch (err) {
        this.reportFailure(context, path, signal?.aborted ? 'deadline' : transportCodeForCause(err), null, null);
        throw err;
      }
      // A permit can settle before this continuation runs. Refuse an
      // intervening abort BEFORE reservation, keeping reserved == dispatched.
      if (signal?.aborted) {
        this.reportFailure(context, path, 'deadline', null, null);
        throw new StatiqAbortError();
      }
      // 2) Atomic reserve immediately before fetch, with NO await between a
      // successful reserve and the dispatch (reservation-race invariant):
      //  - fatal stop (first 429/401/403): this caller fails fast, zero NEW
      //    dispatch after the stop site-wide;
      //  - cap exhausted: ONLY this caller is refused (its earlier-paced
      //    permit is wasted, no traffic) - work already reserved by other
      //    callers proceeds; exhaustion never poisons shared state;
      //  - success: reserved == dispatched, so the shared counters always
      //    match real network work.
      try {
        this.runBudget?.reserveAttempt();
      } catch (err) {
        const code =
          err instanceof UpstreamRunStoppedError && err.cause === 'budget-exhausted'
            ? 'budget_exhausted'
            : err instanceof UpstreamRunStoppedError && err.cause === 'throttled'
              ? 'fatal_throttled'
              : 'fatal_auth';
        this.reportFailure(context, path, code, null, null);
        throw err;
      }
      // Dispatch seq is distinct from completion-order audit seq and exists
      // only after a successful reservation, immediately before fetch.
      const dispatchSeq = ++this.dispatchAttempts;
      try { context?.onDispatch?.(dispatchSeq); } catch { /* evidence callbacks never alter policy */ }
      attemptEvidenceRecorded = false;
      let gatewayFailureCode: ReturnType<typeof parseGatewayFailureCode> = null;
      let gatewayUpstreamStatus: number | null = null;
      const recordAttempt = (code: Parameters<ProviderFailureCollector['record']>[0]['code'], status: number | null): void => {
        if (attemptEvidenceRecorded) return;
        this.reportFailure(context, path, code, dispatchSeq, status,
          gatewayFailureCode, gatewayUpstreamStatus);
        attemptEvidenceRecorded = true;
      };
      // ONE AUDIT PER ATTEMPT: header-time audit marks the attempt as
      // answered on the wire; the catch's audit-0 fallbacks skip when it
      // already ran (a body-read failure after headers must not double-).
      let attemptAudited = false;
      let fatalAtHeaders: StatiqRunFatalError | undefined;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const onOuterAbort = () => controller.abort();
      signal?.addEventListener('abort', onOuterAbort, { once: true });
      try {
        const res = await this.fetchImpl(this.base + path, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        // FATAL HEADERS STOP THE BUDGET IMMEDIATELY (contract repair; the
        // Linux offline repro raced 2/6): a fatal 401/403/429 is fully
        // known at HEADERS, but stopping only after the body resolved left
        // a window where another worker passed the budget gate and
        // DISPATCHED while the fatal body was still in flight.
        // Already-in-flight requests complete as legitimate work; ZERO NEW
        // DISPATCH may follow fatal headers. Diagnostics (audit entry with
        // the true status, the body on the error, the parsed Retry-After)
        // are retained after the stop.
        // Typing note: a LOCAL narrowed budget reference - TS cannot track
        // that fatalCause truthiness implies the budget exists through the
        // ternary, so the guard checks the reference directly. No non-null
        // suppression anywhere.
        // Gateway diagnostic headers are consumed ONLY from failed marker
        // responses. No values are logged, inferred from a status, or applied
        // to policy; header-read failures leave both fields null.
        if (path === '/stations/markers' && !res.ok) {
          try {
            gatewayFailureCode = parseGatewayFailureCode(res.headers?.get('x-evroute-failure-code'));
            if (gatewayFailureCode != null) {
              gatewayUpstreamStatus = parseGatewayUpstreamStatus(
                res.headers?.get('x-evroute-upstream-status'),
              );
            }
          } catch { gatewayFailureCode = null; gatewayUpstreamStatus = null; }
        }
        const budget = this.runBudget;
        const fatalCause =
          !res.ok &&
          budget &&
          (res.status === 401 || res.status === 403 || res.status === 429)
            ? res.status === 429
              ? 'throttled'
              : 'auth'
            : undefined;
        const fatalRetryAfter =
          fatalCause === 'throttled'
            ? this.parseRetryAfterMs(res.headers?.get('retry-after'))
            : undefined;
        if (budget && fatalCause) {
          budget.stop(fatalCause, fatalRetryAfter);
          recordAttempt(fatalCause === 'throttled' ? 'fatal_throttled' : 'fatal_auth', res.status);
          // Preserve the known fatal status even if an aborted body cannot
          // supply diagnostics. No body is invented when none was read.
          fatalAtHeaders = new StatiqRunFatalError(fatalCause, res.status, path, '', fatalRetryAfter);
        }
        // HEADER-TIME AUDIT: the attempt reached the wire and answered with
        // this status - recorded even if the body then never arrives.
        this.audit(path, res.status);
        attemptAudited = true;
        // Observe real headers before cancellation: fatal status must still
        // stop the shared budget and every dispatched attempt audits once.
        if (signal?.aborted) {
          if (fatalAtHeaders) throw fatalAtHeaders;
          recordAttempt('deadline', res.status);
          throw new StatiqAbortError();
        }
        let text: string;
        try {
          text = await res.text();
        } catch (err) {
          if (fatalAtHeaders) throw fatalAtHeaders;
          recordAttempt('body_read_failure', res.status);
          throw err;
        }
        if (fatalCause) {
          // no retry path is entered under a budget: the fatal error carries
          // the full body diagnostics and the parsed wait for honest evidence
          throw new StatiqRunFatalError(fatalCause, res.status, path, text, fatalRetryAfter);
        }
        if (signal?.aborted) throw new StatiqAbortError();
        if (!res.ok) {
          const retryAfter =
            res.status === 429 ? this.parseRetryAfterMs(res.headers?.get('retry-after')) : undefined;
          // No budget (single-call revalidation): 4xx (except 429) are
          // permanent and not retried; 429/5xx retry honoring Retry-After.
          if (res.status >= 500 || res.status === 429) {
            recordAttempt(statusCodeForHttp(res.status), res.status);
            lastError = new StatiqApiError(res.status, path, text, retryAfter);
            lastRetryAfterMs = retryAfter;
            continue;
          }
          throw new StatiqApiError(res.status, path, text, retryAfter);
        }
        let parsed: T;
        try {
          parsed = JSON.parse(text) as T;
        } catch (err) {
          // Preserve the original retry policy; diagnostics only observe.
          // No raw body text is copied into diagnostics.
          recordAttempt('invalid_json', res.status);
          throw err;
        }
        if (!hasFreshProvenance(parsed)) {
          recordAttempt('nonfresh_provenance', res.status);
          throw new StatiqProvenanceError(path);
        }
        return parsed;
      } catch (err) {
        // run-fatal and budget-gate errors are never retried, never
        // counted as sample failures: they unwind the whole planning run
        if (err instanceof StatiqRunFatalError || err instanceof UpstreamRunStoppedError) {
          throw err;
        }
        if (fatalAtHeaders) throw fatalAtHeaders;
        // OUTER cancellation (run deadline / explicit abort) is never
        // retried. Detected by the AUTHORITATIVE signal state, NOT by the
        // error shape: an AbortError-shaped rejection without the outer
        // signal firing is the PER-REQUEST TIMEOUT (the 10s inner
        // controller), which is a retryable transport failure - see below.
        if (signal?.aborted) {
          if (!attemptAudited) this.audit(path, 0);
          recordAttempt('deadline', null);
          throw new StatiqAbortError();
        }
        // Every outbound attempt is auditable, even transport failures.
        // Per-request timeouts land here (inner-controller AbortError with
        // the outer signal alive): audited with status 0 and RETRIED like
        // any network failure - the attempt reached the wire and counts
        // against the run budget (actual attempts include retries). An
        // attempt that already answered at HEADERS is not re-audited (its
        // true status is already recorded; the body read failed after it).
        if (!(err instanceof StatiqApiError) && !attemptAudited) {
          this.audit(path, 0);
        }
        if (err instanceof StatiqProvenanceError) {
          throw err;
        }
        const wireStatus = err instanceof StatiqApiError ? err.status : null;
        const code =
          wireStatus != null && wireStatus > 0
            ? statusCodeForHttp(wireStatus)
            : controller.signal.aborted
              ? 'transport_timeout'
              : transportCodeForCause(err);
        recordAttempt(code, wireStatus != null && wireStatus > 0 ? wireStatus : null);
        if (err instanceof StatiqApiError && err.status < 500 && err.status !== 429) {
          throw err;
        }
        lastError = err;
        continue;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onOuterAbort);
      }
    }
    if (lastError instanceof StatiqApiError) throw lastError;
    // No provider message is copied into the terminal error.
    throw new StatiqApiError(0, path, 'provider request failed');
  }

  /**
   * Parse Retry-After: the delay-seconds form ("120") OR the HTTP-date
   * form ("Wed, 21 Oct 2015 07:28:00 GMT", resolved against the client
   * clock so fake-clock tests stay deterministic). Unparseable -> undefined
   * (the caller falls back to default backoff timing).
   */
  private parseRetryAfterMs(header: string | null | undefined): number | undefined {
    if (!header) return undefined;
    const trimmed = header.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
    const dateMs = Date.parse(trimmed);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - this.now());
    return undefined;
  }
}
