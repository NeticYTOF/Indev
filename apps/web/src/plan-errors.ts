/**
 * Honest, cause-specific guidance for planning failures.
 *
 * The server sends `code: "not_determined"` with a fine-grained `cause`
 * (throttled | auth | budget-exhausted | deadline | sample-throttled |
 * scan-coverage | candidate-holes). Guidance correctness rules:
 *
 *  - Throttle causes NEVER invent a blanket wait ("a minute or two")
 *    and never ASSUME the API supplied one: any exact requested wait
 *    (Retry-After) is in the server evidence shown below the guidance,
 *    referenced only conditionally - "if it specified".
 *  - Budget exhaustion is reported without diagnosing WHY (attempt caps
 *    count retries too; a big candidate pool is only one possibility)
 *    and without promising any retry path succeeds.
 *  - The deadline cause names the RUN, never a specific phase - which
 *    phase it hit is phase-evidence territory (in the server's timings),
 *    not something the guidance asserts.
 *  - Auth means credentials OR access were refused (401/403), not a
 *    definitive token-replacement diagnosis.
 *  - No cause ever claims the route is impossible: not_determined is a
 *    no-verdict outcome, and coverage evidence is never hidden.
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

const THROTTLE_DETAIL =
  'Wait for the pause the API asked for - if it specified an exact wait, that number is in the details below - then try again.';

// Null-prototype map: inherited Object.prototype keys ('toString',
// 'constructor'...) must never masquerade as causes. Lookup is
// own-key-only (hasOwnProperty.call), so a stray 'toString' cause from a
// buggy or hostile server resolves to the DEFAULT guidance instead of a
// prototype function cast to PlanFailureGuidance.
const CAUSE_GUIDANCE: Record<string, PlanFailureGuidance> = Object.assign(
  Object.create(null) as Record<string, PlanFailureGuidance>,
  {
    throttled: {
      title: 'Charger API throttling',
      detail: `The charger API refused this run (429) and asked for a pause, so the plan stopped without a verdict. ${THROTTLE_DETAIL}`,
      toast: 'Plan not determined — charger API throttling. Wait for its pause to lift, then retry.',
    },
    'sample-throttled': {
      title: 'Charger API throttling',
      detail: `A corridor sample was refused with 429 and the scan stopped fail-closed instead of guessing. ${THROTTLE_DETAIL}`,
      toast: 'Plan not determined — charger API throttling. Wait for its pause to lift, then retry.',
    },
    auth: {
      title: 'Charger API credentials rejected',
      detail:
        "The charger API refused this run's credentials (401/403) - the token may be invalid or expired, or the account may lack access to this data. Check the server's STATIQ_API_TOKEN and the account's access first; a retry is only useful after something on that side actually changes.",
      toast: 'Plan not determined — charger API credentials rejected. See details.',
    },
    'budget-exhausted': {
      title: 'Run budget exhausted - not throttling',
      detail:
        'The run used all of its upstream attempts before coverage was complete - every retry counts against the same cap, so a bigger candidate pool is only one possible reason (the attempts/candidates breakdown is in the details below). No verdict was made. Retrying is not guaranteed to succeed; the same cap applies to every run until the operator raises it (INDEV_PLAN_MAX_CALLS).',
      toast: 'Plan not determined — run budget exhausted (the API is not throttling). See details.',
    },
    deadline: {
      title: 'Time budget reached',
      detail:
        "The run exceeded its time budget and was cancelled before the route could be verified - the phase timings in the details below show where it stood. This is not a verdict on the route; the operator can raise the time budget (INDEV_PLAN_DEADLINE_MS).",
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
  } satisfies Record<string, PlanFailureGuidance>,
);

const DEFAULT_GUIDANCE: PlanFailureGuidance = {
  title: 'Plan not determined',
  detail:
    'The planner could not verify this route with what it could fetch, and nothing is claimed either way. This is not a verdict that the route is impossible.',
  toast: 'Plan not determined — see the details below the plan button.',
};

/**
 * Guidance for a server cause string; unknown, absent or
 * prototype-suspicious causes get the honest no-verdict default (never a
 * fake diagnosis, never an inherited-property lookup).
 */
export function planFailureGuidance(cause?: string): PlanFailureGuidance {
  if (
    typeof cause === 'string' &&
    Object.prototype.hasOwnProperty.call(CAUSE_GUIDANCE, cause)
  ) {
    return CAUSE_GUIDANCE[cause] as PlanFailureGuidance;
  }
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
