/**
 * Honest, cause-specific guidance for planning failures.
 *
 * The server sends `code: "not_determined"` with a fine-grained `cause`
 * (throttled | auth | budget-exhausted | deadline | sample-throttled |
 * scan-coverage | candidate-holes). Only the throttle causes mean "the
 * API is busy - wait a minute"; a budget-exhausted run hits the same cap
 * on an instant retry, and auth/deadline/coverage failures are flat-out
 * not retry problems. Every failure gets guidance named after its actual
 * cause; nothing is claimed either way about the route itself.
 *
 * Pure module: no DOM, no maplibre - unit-testable in a plain node env.
 */

export interface PlanFailureGuidance {
  /** Short headline naming what actually happened. */
  title: string;
  /** What (if anything) the user can do - honest about retry value. */
  detail: string;
  /** One-line toast copy; points at the error box for the full story. */
  toast: string;
}

const THROTTLE_WAIT = 'Wait a minute or two, then try again.';

const CAUSE_GUIDANCE: Record<string, PlanFailureGuidance> = {
  throttled: {
    title: 'Charger API throttling',
    detail: `The charger API asked this run to pause (429), so the plan stopped without a verdict. ${THROTTLE_WAIT}`,
    toast: 'Plan not determined — charger API throttling. Wait a minute, then retry.',
  },
  'sample-throttled': {
    title: 'Charger API throttling',
    detail: `A corridor sample was throttled (429) and the scan stopped fail-closed instead of guessing. ${THROTTLE_WAIT}`,
    toast: 'Plan not determined — charger API throttling. Wait a minute, then retry.',
  },
  auth: {
    title: 'Charger API credentials rejected',
    detail:
      "The server's charger API token was rejected (401/403). Retrying will not help - the token needs attention in the server's .env.",
    toast: 'Plan not determined — charger API credentials rejected. See details.',
  },
  'budget-exhausted': {
    title: 'Run budget exhausted - not throttling',
    detail:
      'Every candidate charger is checked individually, and this corridor needs more checks than one run\'s call budget allows. Coverage is incomplete and no verdict was made. Retrying right now hits the same cap; a shorter route fits the budget, or the server\'s run budget can be raised (INDEV_PLAN_MAX_CALLS).',
    toast: 'Plan not determined — run budget exhausted (the API is not throttling). See details.',
  },
  deadline: {
    title: 'Time budget reached',
    detail:
      "The corridor scan exceeded this run's time limit and was cancelled before the route could be verified. This is not a verdict on the route; a shorter corridor completes in time, or the server's time budget can be raised (INDEV_PLAN_DEADLINE_MS).",
    toast: 'Plan not determined — the run exceeded its time budget. See details.',
  },
  'scan-coverage': {
    title: 'Charger coverage incomplete',
    detail:
      'Too many corridor samples could not be read, so charging coverage along the route is unknown. This is not a verdict that the route is impossible.',
    toast: 'Plan not determined — charger coverage incomplete. See details.',
  },
  'candidate-holes': {
    title: 'Candidate chargers unreadable',
    detail:
      'Some per-station lookups failed, so the charging-stop options are incomplete. This is not a verdict that the route is impossible.',
    toast: 'Plan not determined — some candidate chargers were unreadable. See details.',
  },
};

const DEFAULT_GUIDANCE: PlanFailureGuidance = {
  title: 'Plan not determined',
  detail:
    'The planner could not verify this route with what it could fetch, and nothing is claimed either way. This is not a verdict that the route is impossible.',
  toast: 'Plan not determined — see the details below the plan button.',
};

/** Guidance for a server cause string; unknown/absent causes get the
 *  honest no-verdict default (never a fake diagnosis). */
export function planFailureGuidance(cause?: string): PlanFailureGuidance {
  if (cause && cause in CAUSE_GUIDANCE) return CAUSE_GUIDANCE[cause] as PlanFailureGuidance;
  return DEFAULT_GUIDANCE;
}

/** The causes that genuinely mean "the API asked us to slow down". */
export function isThrottleCause(cause?: string): boolean {
  return cause === 'throttled' || cause === 'sample-throttled';
}

/** Elapsed wall time, for honest loading state (real timing, not fake
 *  progress): "0s", "45s", "1m 5s", "1h 2m". */
export function formatElapsedMs(ms: number): string {
  const totalS = Math.max(0, Math.floor(ms / 1000));
  if (totalS < 60) return `${totalS}s`;
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}
