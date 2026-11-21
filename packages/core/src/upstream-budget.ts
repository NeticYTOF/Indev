/**
 * Shared upstream attempt budget for ONE planning run.
 *
 * DISPATCH-ACCOUNTING INVARIANTS (reservation-race fix):
 * - A transport attempt is reserved ATOMICALLY IMMEDIATELY BEFORE its
 *   dispatch (no await between a successful reserve and the fetch), so
 *   reserved == dispatched: the counters always match real network work.
 * - Waiting for the paced permit (limiter/backoff) happens BEFORE the
 *   reservation: no up-front reservation can be cancelled by another
 *   waiter's exhaustion.
 * - CAP EXHAUSTION IS PER-CALLER, never run-fatal: a caller that finds no
 *   room is refused without dispatching, and work ALREADY reserved by
 *   other callers proceeds - exhaustion never poisons shared state
 *   (the historical bug: N>cap concurrent callers reported attempts and
 *   globally stopped the run before anyone dispatched - actual 0).
 * - FATAL STOPS (first 429 throttle / 401-403 auth) ARE run-global: every
 *   caller fails fast at the next reservation recheck, with zero NEW
 *   dispatch after the stop (in-flight responses are not "new").
 * - A parsed Retry-After (delay-seconds or HTTP-date) is recorded on the
 *   budget so failure evidence can report the server-demanded wait for
 *   any FUTURE request.
 */

/** Cause carried by the reservation/stop control-flow error. */
export type UpstreamStopCause = 'throttled' | 'auth' | 'budget-exhausted';

/** Run-fatal causes only (observed on the wire: throttle/auth responses). */
export type UpstreamFatalCause = 'throttled' | 'auth';

/** Control-flow error for a refused reservation or a fatal stop. */
export class UpstreamRunStoppedError extends Error {
  constructor(
    readonly cause: UpstreamStopCause,
    readonly attemptsMade: number,
    readonly maxAttempts: number,
    readonly retryAfterMs?: number,
  ) {
    super(
      `Upstream run ${cause === 'budget-exhausted' ? 'hit its attempt cap' : `stopped (${cause})`}` +
        ` after ${attemptsMade} of ${maxAttempts} attempts` +
        (retryAfterMs != null ? `; server Retry-After ${Math.ceil(retryAfterMs / 1000)}s` : ''),
    );
    this.name = 'UpstreamRunStoppedError';
  }
}

/** Mutable run-scope budget shared by the planner and one StatiqClient. */
export class UpstreamBudget {
  readonly maxAttempts: number;
  private attempts = 0;
  /** Attempts reserved pessimistically by a bulk batch and not yet
   *  settled from a verified envelope. Unknown transports never settle,
   *  so these stay reserved and the run fails closed. */
  private pendingReservations = 0;
  /** RUN-FATAL cause only (throttle/auth). Cap exhaustion is NEVER stored
   *  here: it refuses only the caller that finds no room. */
  private fatalCause: UpstreamFatalCause | null = null;
  private fatalRetryAfterMs: number | undefined;

  constructor(maxAttempts: number) {
    if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
      throw new Error('UpstreamBudget requires a positive maxAttempts');
    }
    this.maxAttempts = Math.floor(maxAttempts);
  }

  /** Reservation slots consumed so far. Legacy: == dispatched (reserves
   *  precede fetches). Bulk: includes pessimistically held attempts that are
   *  NOT yet observed dispatches until settleBatch reconciles them. Use
   *  `completedAttempts` for observed actual attempts and `reservedButUnknown`
   *  for unresolved holds. The cap is enforced against this worst-case count. */
  get attemptsMade(): number {
    return this.attempts;
  }

  /** Run-fatal stop (first 429 / 401-403) or null while the run may continue. */
  get stopped(): UpstreamFatalCause | null {
    return this.fatalCause;
  }

  /** Server-demanded wait parsed from the fatal response, if present. */
  get retryAfterMs(): number | undefined {
    return this.fatalRetryAfterMs;
  }

  /** True when the attempt cap is reached (per-caller refusal, not fatal). */
  get exhausted(): boolean {
    return this.attempts >= this.maxAttempts;
  }

  /** Reserved but not yet confirmed by a verified bulk envelope. Unknown
   *  transports never settle, so these remain held and the run fails closed;
   *  they are NOT completed or observed upstream dispatches. */
  get reservedButUnknown(): number {
    return this.pendingReservations;
  }

  /** Truthful observed upstream attempts, excluding unresolved holds.
   *  Planner coverage/error evidence uses this, never `attemptsMade`, when
   *  describing ACTUAL dispatches. */
  get completedAttempts(): number {
    return this.attempts - this.pendingReservations;
  }

  /** Reserve N attempts pessimistically before one bulk batch dispatch.
   *  Fatal stops and cap exhaustion refuse BEFORE traffic; exhaustion is
   *  per-caller exactly like reserveAttempt, preserving the legacy
   *  reservation-race invariant. */
  reserveBatch(count: number): void {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error('reserveBatch requires a positive integer count');
    }
    if (this.fatalCause !== null) {
      throw new UpstreamRunStoppedError(
        this.fatalCause, this.attempts, this.maxAttempts, this.fatalRetryAfterMs,
      );
    }
    if (this.attempts + count > this.maxAttempts) {
      throw new UpstreamRunStoppedError('budget-exhausted', this.attempts, this.maxAttempts);
    }
    this.attempts += count;
    this.pendingReservations += count;
  }

  /** Release ONLY the observed-unused portion of a verified reservation.
   *  Call with an authoritative envelope count alone; unknown transports
   *  must never settle, so their hold stays consumed. */
  settleBatch(reserved: number, observed: number): void {
    if (!Number.isInteger(reserved) || !Number.isInteger(observed) ||
        observed < 0 || observed > reserved || reserved > this.pendingReservations) {
      throw new Error('settleBatch received an inconsistent accounting');
    }
    this.attempts -= reserved - observed;
    this.pendingReservations -= reserved;
  }

  /**
   * Reserve one upstream attempt. Call this ATOMICALLY immediately before
   * dispatch (NO await between a successful reserve and the fetch), after
   * the paced permit has been awaited. Throws - before any traffic - when:
   *  - the run is fatally stopped (throttle/auth): no caller may dispatch;
   *  - the cap is reached: THIS caller is refused; already-reserved work
   *    elsewhere proceeds untouched (exhaustion never poisons shared state).
   */
  reserveAttempt(): void {
    if (this.fatalCause !== null) {
      throw new UpstreamRunStoppedError(
        this.fatalCause,
        this.attempts,
        this.maxAttempts,
        this.fatalRetryAfterMs,
      );
    }
    if (this.attempts >= this.maxAttempts) {
      // PER-CALLER refusal: no shared state changes, so waiters holding
      // valid reservations still dispatch (reserved == dispatched).
      throw new UpstreamRunStoppedError('budget-exhausted', this.attempts, this.maxAttempts);
    }
    this.attempts += 1;
  }

  /**
   * Stop the whole run (first 429 / 401 / 403 observed on the wire).
   * Idempotent: the first fatal cause wins. `retryAfterMs` records the
   * server-demanded wait for honest reporting - it is honored by NOT
   * dispatching at all, never by sleeping through it in this run.
   */
  stop(cause: UpstreamFatalCause, retryAfterMs?: number): void {
    if (this.fatalCause === null) {
      this.fatalCause = cause;
      if (retryAfterMs != null && Number.isFinite(retryAfterMs)) {
        this.fatalRetryAfterMs = Math.max(0, retryAfterMs);
      }
    }
  }
}
