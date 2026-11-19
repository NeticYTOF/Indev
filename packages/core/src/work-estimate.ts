/**
 * Derived work estimates for one planning run (completion-contract batch).
 *
 * ADVISORY REPORTING ONLY. These figures NEVER gate execution: the owner
 * policy is every-candidate-checked, and a planning run always proceeds
 * until its run budget / deadline is hit - the estimates exist solely for
 * honest failure evidence ("how much work would full coverage still need").
 *
 * Grounded by the Linux markers-only discovery at a246950 (Delhi -> Jaipur):
 * 25/25 marker calls returned HTTP 200 in 48.674s, discovering 640 unique
 * listings -> 396 corridor candidates (155 primary + 241 fallback). Fresh
 * FULL coverage of that route therefore needs >= 421 actual calls before
 * any retry (25 samples + 396 unique per-station lookups) - observed N for
 * that corridor, never permission to freeze or stale-reuse coverage (the
 * every-candidate, live-only rule stands: each run fetches fresh).
 *
 * The wall-time figure is a ROUGH SUSTAINED-PACING ESTIMATE, explicitly NOT
 * a strict finite-run lower bound: the first dispatch is ~immediate, and
 * rolling-window credits (stamps aging out of the 62s retention) let real
 * runs finish somewhat faster or slower than the naive product. Assumptions:
 * - one upstream call per planned sample and per unique candidate
 *   (exhaustive every-candidate coverage, within-run memo reuse is free);
 * - ZERO retries (the client default is 2, which can only ADD calls);
 * - upstream latency, backoff sleeps and processing time are EXCLUDED
 *   (they can only add wall time).
 *
 * The sustained pace model uses the limiter's OWN retention
 * (WINDOW_RETENTION_MS = 62s, shared so this module and the limiter can
 * never drift): with maxCallsPerMinute = 25, effective sustained pacing is
 * 25 calls per 62s -> 2480ms per call (Linux measured the effective window
 * at ~62.05s; the RETAINED-stamp boundary is deliberately conservative).
 */
import { WINDOW_RETENTION_MS } from './statiq.js';

/** The shared safety pacing (PROJECT SAFETY DEFAULTS, not a provider contract). */
export interface SafetyPacing {
  maxCallsPerMinute: number;
  minCallGapMs: number;
  windowRetentionMs: number;
}

export const SAFETY_PACING: SafetyPacing = {
  maxCallsPerMinute: 25,
  minCallGapMs: 2_000,
  windowRetentionMs: WINDOW_RETENTION_MS,
};

/**
 * Sustained per-call pace under the shared limiter, ms: the binding of the
 * minimum gap and the (retention-conservative) rolling window. Rough
 * model for estimates - the true schedule also depends on dispatch order
 * and window credits.
 */
export function pacePerCallMs(pacing: SafetyPacing = SAFETY_PACING): number {
  return Math.max(pacing.minCallGapMs, pacing.windowRetentionMs / Math.max(1, pacing.maxCallsPerMinute));
}

/** Counters the planner already maintains (RunProgressStats shape). */
export interface RunWorkInput {
  samplesPlanned: number;
  samplesCompleted: number;
  candidatesPlanned: number;
  candidatesProcessed: number;
}

export interface RunWorkEstimate {
  /** Samples + unique candidates this run plans to touch (one call each). */
  totalPlannedCalls: number;
  /** Calls already completed (sample responses + per-station lookups). */
  completedCalls: number;
  /** Remaining calls required for full fresh coverage (>= 0). */
  remainingCalls: number;
  /**
   * ROUGH sustained-pacing wall estimate for the remaining calls, ms.
   * Advisory reporting only - NOT a strict bound (first-dispatch and
   * rolling-window credits shift the true time), and NEVER a gate.
   */
  remainingEstimateMs: number;
  /** The assumed per-call pace, ms (see pacePerCallMs). */
  pacePerCallMs: number;
}

/** Derive the (advisory) full-coverage work estimate from the live counters. */
export function estimateRunWork(
  input: RunWorkInput,
  pacing: SafetyPacing = SAFETY_PACING,
): RunWorkEstimate {
  const pace = pacePerCallMs(pacing);
  const totalPlannedCalls = input.samplesPlanned + input.candidatesPlanned;
  const completedCalls = input.samplesCompleted + input.candidatesProcessed;
  const remainingCalls = Math.max(0, totalPlannedCalls - completedCalls);
  return {
    totalPlannedCalls,
    completedCalls,
    remainingCalls,
    remainingEstimateMs: remainingCalls * pace,
    pacePerCallMs: pace,
  };
}
