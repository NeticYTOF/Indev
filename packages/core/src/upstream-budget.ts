/**
 * Shared upstream attempt budget for ONE planning run.
 *
 * BY-CONSTRUCTION invariants (coordinator reliability batch):
 * - ONE budget object per planning run is shared by the planner and the
 *   StatiqClient. Every ACTUAL transport attempt - including in-client 5xx
 *   retries - reserves against it; a logical-dispatch fallback covers
 *   duck-typed statiq doubles that cannot count retries themselves.
 * - The budget is a HARD cap: when the cap is reached the run fails with
 *   'budget-exhausted'. The planner maps that to an honest
 *   not_determined outcome (coverage undetermined - NEVER a verdict that
 *   the route is impossible, never silent confidence).
 * - The first 429 (throttle) or 401/403 (auth) STOPS the run: no further
 *   upstream traffic, no sleep-then-retry, no bypassing the server's
 *   limit. Concurrent workers fail fast at their next reserve - without
 *   touching the network.
 * - A parsed Retry-After (delay-seconds or HTTP-date) is recorded on the
 *   budget so the failure evidence can report the server-demanded wait
 *   for any FUTURE request honestly.
 */

export type UpstreamStopCause = 'throttled' | 'auth' | 'budget-exhausted';

/** Severity message for run-stop control flow (never a sample failure). */
export class UpstreamRunStoppedError extends Error {
  constructor(
    readonly cause: UpstreamStopCause,
    readonly attemptsMade: number,
    readonly maxAttempts: number,
    readonly retryAfterMs?: number,
  ) {
    super(
      `Upstream run stopped (${cause}) after ${attemptsMade} of ${maxAttempts} attempts` +
        (retryAfterMs != null ? `; server Retry-After ${Math.ceil(retryAfterMs / 1000)}s` : ''),
    );
    this.name = 'UpstreamRunStoppedError';
  }
}

/** Mutable run-scope budget shared by the planner and one StatiqClient. */
export class UpstreamBudget {
  readonly maxAttempts: number;
  private attempts = 0;
  private stoppedCause: UpstreamStopCause | null = null;
  private stoppedRetryAfterMs: number | undefined;

  constructor(maxAttempts: number) {
    if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
      throw new Error('UpstreamBudget requires a positive maxAttempts');
    }
    this.maxAttempts = Math.floor(maxAttempts);
  }

  /** Attempts reserved so far (dispatched or in flight). Never decreased. */
  get attemptsMade(): number {
    return this.attempts;
  }

  /** Why the run stopped, or null while it may continue. */
  get stopped(): UpstreamStopCause | null {
    return this.stoppedCause;
  }

  /** Server-demanded wait parsed from the stopping response, if present. */
  get retryAfterMs(): number | undefined {
    return this.stoppedRetryAfterMs;
  }

  /**
   * Reserve one upstream attempt (each transport try, retries included -
   * or one logical dispatch for duck-typed fakes). Throws when the run is
   * already stopped, or when the hard cap is reached (stopping the run as
   * 'budget-exhausted'). Throws BEFORE any traffic: the caller may not
   * dispatch after this fails.
   */
  reserveAttempt(): void {
    // Fast-fail without transport: a already-stopped run never talks upstream.
    if (this.stoppedCause !== null) {
      throw new UpstreamRunStoppedError(
        this.stoppedCause,
        this.attempts,
        this.maxAttempts,
        this.stoppedRetryAfterMs,
      );
    }
    if (this.attempts >= this.maxAttempts) {
      this.stoppedCause = 'budget-exhausted';
      throw new UpstreamRunStoppedError('budget-exhausted', this.attempts, this.maxAttempts);
    }
    this.attempts += 1;
  }

  /**
   * Stop the whole run (first 429 / 401 / 403). Idempotent: the first
   * cause wins. `retryAfterMs` records the server-demanded wait for
   * honest reporting - it is honored by NOT making the request at all.
   */
  stop(cause: UpstreamStopCause, retryAfterMs?: number): void {
    if (this.stoppedCause === null) {
      this.stoppedCause = cause;
      if (retryAfterMs != null && Number.isFinite(retryAfterMs)) {
        this.stoppedRetryAfterMs = Math.max(0, retryAfterMs);
      }
    }
  }
}
