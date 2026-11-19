/**
 * Single-flight gate for planning runs - the plan and AI submit paths are
 * mutually exclusive.
 *
 * Grounded, not cosmetic: each planning run opens its own upstream
 * request window (the server builds a per-run client + limiter), so
 * two overlapping UI runs would double the effective request rate
 * against the charger API - never assumed safe under this project's
 * safety-pacing stance.
 *
 * This is also the lifecycle repair for the shared busy/elapsed
 * readout: with single flight, exactly one start/stop pair owns the
 * readout, so one run's finally can never hide a still-pending other
 * run (the shared-timer defect found in independent review).
 *
 * Pure module - unit-testable in a plain node env.
 */
export class SubmitGate {
  private active = false;

  /** Try to begin a planning run. Returns false when another run is
   *  still in flight - the caller must not start work in that case. */
  tryBegin(): boolean {
    if (this.active) return false;
    this.active = true;
    return true;
  }

  /** Release the gate. Call exactly once per successful begin (the
   *  finally path of the owning run). */
  end(): void {
    this.active = false;
  }

  /** Whether a planning run is currently in flight. */
  inFlight(): boolean {
    return this.active;
  }
}
