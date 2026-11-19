/**
 * Work-estimate unit tests (pure arithmetic, deterministic).
 *
 * ADVISORY SEMANTICS: these figures are reporting-only and NEVER gate
 * execution (the owner policy is every-candidate-checked; runs proceed
 * until the run budget / deadline is hit).
 *
 * Grounded by the Linux markers-only discovery at a246950 (Delhi -> Jaipur):
 * 25 marker samples + 396 unique corridor candidates -> fresh FULL coverage
 * needs >= 421 actual calls before retries; at the shared sustained pacing
 * (25 calls per 62s retention window + 2s min gap -> 2.48s/call) the naive
 * product is ~17.4 min - pinned below as the rough estimate it is.
 */
import { describe, expect, it } from 'vitest';
import {
  SAFETY_PACING,
  estimateRunWork,
  pacePerCallMs,
} from '../src/work-estimate.js';
import { WINDOW_RETENTION_MS } from '../src/statiq.js';

describe('pacePerCallMs (shared safety pacing model)', () => {
  it('defaults: window retention binds over the 2s minimum gap', () => {
    // max(2000, 62000 / 25) = 2480ms per call sustained
    expect(pacePerCallMs()).toBe(2480);
  });

  it('the gap binds when the window is wide', () => {
    expect(pacePerCallMs({ maxCallsPerMinute: 25, minCallGapMs: 5_000, windowRetentionMs: WINDOW_RETENTION_MS }))
      .toBe(5_000);
  });

  it('the shared constant keeps the estimator and the limiter from drifting', () => {
    expect(SAFETY_PACING.windowRetentionMs).toBe(WINDOW_RETENTION_MS);
    expect(SAFETY_PACING.maxCallsPerMinute).toBe(25);
    expect(SAFETY_PACING.minCallGapMs).toBe(2_000);
  });
});

describe('estimateRunWork (advisory, derived from run counters)', () => {
  it('GROUNDED Delhi->Jaipur shape: 25 samples + 396 candidates = 421 calls', () => {
    const est = estimateRunWork({
      samplesPlanned: 25,
      samplesCompleted: 25,
      candidatesPlanned: 396,
      candidatesProcessed: 396,
    });
    expect(est.totalPlannedCalls).toBe(421);
    expect(est.remainingCalls).toBe(0);
    expect(est.remainingEstimateMs).toBe(0);
  });

  it('GROUNDED fresh-run shape: 421 remaining calls, ~17.4 min rough pacing estimate', () => {
    // nothing fetched yet: the full fresh-coverage requirement
    const est = estimateRunWork({
      samplesPlanned: 25,
      samplesCompleted: 0,
      candidatesPlanned: 396,
      candidatesProcessed: 0,
    });
    expect(est.remainingCalls).toBe(421);
    expect(est.remainingEstimateMs).toBe(421 * 2480);
    expect(est.remainingEstimateMs / 60_000).toBeCloseTo(17.4, 1);
  });

  it('mid-run counters: the remainder is what still needs fetching', () => {
    const est = estimateRunWork({
      samplesPlanned: 25,
      samplesCompleted: 25,
      candidatesPlanned: 396,
      candidatesProcessed: 74,
    });
    expect(est.completedCalls).toBe(99);
    expect(est.remainingCalls).toBe(322); // the observed 100-call run shape
    expect(est.remainingEstimateMs).toBe(322 * 2480);
  });

  it('a custom pacing override is respected (estimates stay explicit)', () => {
    const est = estimateRunWork(
      { samplesPlanned: 10, samplesCompleted: 10, candidatesPlanned: 5, candidatesProcessed: 0 },
      { maxCallsPerMinute: 25, minCallGapMs: 2_000, windowRetentionMs: 60_000 },
    );
    // max(2000, 60000/25) = 2400ms/call with the idealized 60s window
    expect(est.pacePerCallMs).toBe(2_400);
    expect(est.remainingEstimateMs).toBe(5 * 2_400);
  });

  it('never reports negative remainders on malformed counters', () => {
    const est = estimateRunWork({
      samplesPlanned: 5,
      samplesCompleted: 7, // more than planned (defensive)
      candidatesPlanned: 0,
      candidatesProcessed: 0,
    });
    expect(est.remainingCalls).toBe(0);
  });
});
