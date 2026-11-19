/**
 * Charging stop planner.
 *
 * Strategy (per spec):
 * - Fewest charging stops: jump to the farthest reachable station within a
 *   300 km gap, preferring 250-300 km legs.
 * - Minimal charging: each stop charges just enough for the next hop plus a
 *   safety buffer, so arrival SoC stays low and time is not wasted.
 * - Do not detour far for a preferred charger: stations beyond
 *   `primaryDetourKm` off-route are used only if the primary band fails.
 * - Exhaustive candidate coverage (owner directive): every unique
 *   candidate in both detour bands is checked via individual per-station
 *   lookups with multiple checks in flight - no bulk endpoint, no
 *   window/candidate pruning. Concurrency never reduces the request
 *   count or removes pacing.
 * - Brand preference Statiq > Tata > BPCL > HP > others breaks ties only
 *   inside a small chainage cluster, never at the cost of an extra stop.
 * - Charger data is fetched live during this run and never persisted.
 */
import { cumulativeKm } from './geo.js';
import { scanCorridor, type CorridorCandidate } from './corridor.js';
import { classifyPlug, summarizeCcs2, type Ccs2Summary } from './plugs.js';
import { detectBrand } from './brands.js';
import { pMap } from './utils.js';
import { chargeTimeMin, kwhForSocDelta, socAfterDriving, socRequiredForArrival, HARIER_EV_75, type VehicleConfig } from './vehicle.js';
import type { OsrmRouter } from './router.js';
import { isAbortLike, StatiqRunFatalError, type StatiqClient } from './statiq.js';
import { UpstreamBudget, UpstreamRunStoppedError } from './upstream-budget.js';
import { estimateRunWork } from './work-estimate.js';
import type { StatiqStationDetail } from './types.js';
import { resolveVehicle, type ResolvedVehicle } from './vehicle-catalog.js';
import {
  DEFAULT_PLAN_OPTIONS,
  type PlanCandidate,
  type PlanOptions,
  type PlanRunBudget,
  type PlanStatus,
  type PlanStop,
  type PlanTotals,
  type PlanVehicleMeta,
  type StationLiveView,
  type TripPlan,
} from './plan-types.js';

export interface PlannerDeps {
  router: OsrmRouter;
  statiq: StatiqClient;
  vehicle?: VehicleConfig;
  /** Resolved vehicle to stamp on the plan; defaults to the default Harrier profile. */
  resolvedVehicle?: ResolvedVehicle;
}

interface Candidate {
  candidate: CorridorCandidate;
  summary: Ccs2Summary;
  view: StationLiveView;
}

export type { Candidate as PlannerCandidate };
export interface PlanBundle {
  plan: TripPlan;
  /** Rich usable candidates from this run (views incl. plug health). */
  usableCandidates: Candidate[];
  route: { distanceKm: number; durationMin: number; geometry: import('./geo.js').Coords[] };
}

interface Cursor {
  chainageKm: number;
  /** detour to rejoin the route from this point (0 for the origin). */
  detourKm: number;
  socPct: number;
  /** true when the cursor cannot charge (trip origin). */
  isOrigin: boolean;
}

interface ChosenStop {
  cand: Candidate;
  legKm: number;
  arriveSocPct: number;
}

export type { ChosenStop };

/** Fine-grained cause carried on not_determined outcomes (audit + UI). */
export type NotDeterminedCause =
  | 'throttled' // run-level first 429 (client budget stop)
  | 'auth' // 401/403: upstream rejected credentials
  | 'budget-exhausted' // hard attempt cap reached before full coverage
  | 'deadline' // time budget reached; run cancelled
  | 'sample-throttled' // a corridor sample saw a 429 (fail-closed scan)
  | 'scan-coverage' // too many failed samples: coverage incomplete
  | 'candidate-holes'; // per-station lookups failed: impossibility claims unsafe

export class PlanningError extends Error {
  /** Machine-readable outcome for UI/MCP: not_determined is never a plan. */
  constructor(
    message: string,
    readonly code:
      | 'not_determined'
      | 'no_route'
      | 'infeasible' = 'infeasible',
    /** Optional fine-grained cause (used for not_determined audit outcomes). */
    readonly cause?: NotDeterminedCause,
  ) {
    super(message);
    this.name = 'PlanningError';
  }
}

const BRAND_ORDER: Record<StationLiveView['brand'], number> = {
  statiq: 0,
  tata: 1,
  bpcl: 2,
  hp: 3,
  other: 4,
};

/** Stop-to-stop leg: rejoin the route, drive the chainage, exit to next stop. */
function legKmBetween(prev: Cursor, chainageKm: number, detourKm: number): number {
  return chainageKm - prev.chainageKm + prev.detourKm + detourKm;
}

export const DEFAULT_RUN_BUDGET: PlanRunBudget = {
  deadlineMs: 5 * 60_000,
  maxUpstreamCalls: 220,
};

/**
 * Merge options over defaults WITHOUT letting explicit undefined fields
 * erase a default (a classic spread bug that produced NaN-free 0-stop plans).
 */
function mergePlanOptions(options: PlanOptions): Required<PlanOptions> {
  const clean: PlanOptions = {};
  for (const [k, v] of Object.entries(options)) {
    if (v !== undefined) {
      (clean as Record<string, unknown>)[k] = v;
    }
  }
  return { ...DEFAULT_PLAN_OPTIONS, ...clean };
}

export async function planTrip(
  deps: PlannerDeps,
  origin: { label: string; lat: number; lon: number },
  destination: { label: string; lat: number; lon: number },
  options: PlanOptions = {},
): Promise<TripPlan> {
  return (await planTripDetailed(deps, origin, destination, options)).plan;
}

/**
 * Like planTrip, but also returns this run's rich candidate set and route,
 * so callers (e.g. the AI planner) can validate and rebuild alternatives
 * without re-fetching anything live.
 */
export async function planTripDetailed(
  deps: PlannerDeps,
  origin: { label: string; lat: number; lon: number },
  destination: { label: string; lat: number; lon: number },
  options: PlanOptions = {},
): Promise<PlanBundle> {
  const opts = mergePlanOptions(options);
  const vehicle = deps.vehicle ?? HARIER_EV_75;
  const resolvedVehicle: ResolvedVehicle = deps.resolvedVehicle ?? resolveVehicle();
  const vehicleMeta: PlanVehicleMeta = {
    label: resolvedVehicle.label,
    catalogId: resolvedVehicle.catalogId,
    batteryKwh: resolvedVehicle.batteryKwh,
    claimedRangeKm: resolvedVehicle.claimedRangeKm,
    realWorldRangeKm: resolvedVehicle.realWorldRangeKm,
  };

  // Bounded run: overall deadline + a HARD shared attempt budget.
  // The budget is enforced at the TRANSPORT level when the client supports
  // it (real StatiqClient: every attempt incl. retries counts, and the first
  // 429/401/403 stops the run); duck-typed statiq doubles fall back to
  // logical per-dispatch counting. Either way the planner converts run
  // stops into an honest not_determined with coverage evidence - never a
  // verdict on the route, never silent confidence.
  const runBudgetSpec = opts.runBudget ?? DEFAULT_RUN_BUDGET;
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(),
    Math.max(50, runBudgetSpec.deadlineMs),
  );
  const runBudget = new UpstreamBudget(runBudgetSpec.maxUpstreamCalls);
  const stats: RunProgressStats = {
    samplesPlanned: 0,
    samplesCompleted: 0,
    samplesOk: 0,
    samplesFailed: 0,
    candidatesPlanned: 0,
    candidatesProcessed: 0,
    candidatesDetailed: 0,
    scanMs: 0,
    detailsStartedAt: null,
  };

  let clientBudgeted = false;
  if (typeof deps.statiq.attachRunBudget === 'function') {
    deps.statiq.attachRunBudget(runBudget);
    clientBudgeted = true;
  }
  const hooks: GuardHooks = {
    // Logical fallback only for statiq doubles without budget enforcement.
    reserveCall: clientBudgeted ? undefined : () => runBudget.reserveAttempt(),
    budget: runBudget,
    stats,
    signal: deadlineController.signal,
  };

  try {
  const bundle = await planCore(deps, origin, destination, opts, vehicle, vehicleMeta, hooks);
  return bundle;
  } catch (err) {
  if (err instanceof PlanningError) throw err;
  // Run-fatal upstream stops (first throttle/auth) and per-caller cap
  // refusals (budget-exhausted; never retroactively cancelling reserved
  // work) both unwind the run as an honest not_determined
  if (err instanceof UpstreamRunStoppedError || err instanceof StatiqRunFatalError) {
    throw notDeterminedFromStop(runBudget, stats);
  }
  if (isAbortLike(err)) {
    throw notDeterminedDeadline(runBudget, stats);
  }
  throw err;
  } finally {
  // Cancellation cleanup: never let a generous deadline hold the run.
  clearTimeout(deadlineTimer);
  // If the run is still in flight anywhere (exception paths), cancel it.
  deadlineController.abort();
  }
}

/** Progress markers so a failed run can report honest coverage evidence. */
export interface RunProgressStats {
  /** Marker sample points the corridor planned (known plan-first). */
  samplesPlanned: number;
  /**
   * Samples COMPLETED before the stop: responses received (ok or failed).
   * In-flight/fatal-unwound samples are not completed. This is a completion
   * count, never a dispatch count - actual transport attempts are counted
   * separately by the run budget and reported as 'N of M upstream attempts'.
   */
  samplesCompleted: number;
  samplesOk: number;
  samplesFailed: number;
  /** Unique candidate pool planned for the details phase (both bands). */
  candidatesPlanned: number;
  /** Candidates whose per-station lookup COMPLETED (fetched, empty or skipped). */
  candidatesProcessed: number;
  /** Candidates successfully detailed into the selection pool. */
  candidatesDetailed: number;
  /** Corridor scan phase wall time, ms (set when the scan returns). */
  scanMs: number;
  /** Details-phase start (Date.now() epoch; null until the phase starts). */
  detailsStartedAt: number | null;
}

/** Human-readable aggregate for not_determined evidence (run level). */
function coverageEvidence(stats: RunProgressStats): string {
  const bits: string[] = [];
  if (stats.samplesCompleted > 0 || stats.samplesPlanned > 0) {
    // Mid-scan stops carry the partially-completed plan honestly: the
    // completed-so-far count plus the full planned denominator. Display is
    // OK/COMPLETED/PLANNED - a completion count, never a dispatch count
    // (actual attempts are the separate 'N of M upstream attempts' figure).
    const plannedSuffix =
      stats.samplesPlanned > stats.samplesCompleted ? ` of ${stats.samplesPlanned} planned` : '';
    bits.push(
      `route samples covered ${stats.samplesOk}/${stats.samplesCompleted}` +
        `${plannedSuffix}` +
        (stats.samplesFailed > 0 ? ` (${stats.samplesFailed} failed)` : ''),
    );
  }
  if (stats.candidatesPlanned > 0) {
    const remaining = Math.max(0, stats.candidatesPlanned - stats.candidatesProcessed);
    bits.push(
      `candidates processed ${stats.candidatesProcessed}/${stats.candidatesPlanned}` +
        ` (${stats.candidatesDetailed} detailed, ${remaining} remaining)`,
    );
  }
  // DERIVED WORK ESTIMATE (ADVISORY REPORTING ONLY - never gates
  // execution; the owner policy is every-candidate-checked, and runs
  // proceed until the budget/deadline is hit). Sustained-pacing product,
  // explicitly NOT a strict finite-run bound: first-dispatch and
  // rolling-window credits shift the true time either way.
  const est = estimateRunWork(stats);
  if (est.remainingCalls > 0) {
    const scanIncomplete = stats.samplesPlanned > stats.samplesCompleted;
    bits.push(
      `rough estimate: ~${est.remainingCalls} more upstream calls remain for full fresh coverage` +
        ` (~${(est.remainingEstimateMs / 60_000).toFixed(1)} min at` +
        ` ~${(est.pacePerCallMs / 1000).toFixed(2)}s/call sustained safety pacing - advisory,` +
        ' a sustained-pacing estimate, not a strict bound; zero-retry assumption - latency, backoff and retries only add' +
        (scanIncomplete ? '; the candidate pool is not yet discovered' : '') +
        ')',
    );
  }
  const timings: string[] = [];
  if (stats.scanMs > 0) timings.push(`scan phase ~${Math.round(stats.scanMs)}ms`);
  if (stats.detailsStartedAt != null) {
    timings.push(`details phase ~${Math.max(0, Math.round(Date.now() - stats.detailsStartedAt))}ms so far`);
  }
  if (timings.length > 0) bits.push(timings.join(', '));
  return bits.length > 0 ? ` ${bits.join('; ')}.` : '';
}

/**
 * Map an upstream stop to an honest not_determined. Fatal stops
 * (throttle/auth) are read from the budget; a null fatal cause means the
 * unwinding error was a per-caller cap refusal (budget-exhausted -
 * reserved work was never cancelled, the run simply found no room).
 */
function notDeterminedFromStop(budget: UpstreamBudget, stats: RunProgressStats): PlanningError {
  const coverage = coverageEvidence(stats);
  const attempts = `after ${budget.attemptsMade} of ${budget.maxAttempts} upstream attempts`;
  if (budget.stopped === 'throttled') {
    const wait =
      budget.retryAfterMs != null
        ? ` The API asked to wait ${Math.ceil(budget.retryAfterMs / 1000)}s before any future request.`
        : '';
    return new PlanningError(
      `Plan not determined: the charger API throttled this run (429) ${attempts}.${coverage}` +
        ' No plan was produced, nothing is verified and no trip was saved - this is not a verdict on the route.' +
        wait,
      'not_determined',
      'throttled',
    );
  }
  if (budget.stopped === 'auth') {
    return new PlanningError(
      `Plan not determined: the charger API rejected this run's credentials (401/403) ${attempts}.${coverage}` +
        " No plan was produced and no trip was saved. Check the server's STATIQ_API_TOKEN.",
      'not_determined',
      'auth',
    );
  }
  // budget-exhausted: coverage is undetermined - never a route-impossibility
  // claim, never silent confidence.
  return new PlanningError(
    `Plan not determined: the run exhausted its budget of ${budget.maxAttempts} upstream attempts` +
      ` before the whole route could be scanned.${coverage}` +
      ' Coverage is incomplete - this is NOT a verdict that the route is impossible, and no trip was saved.' +
      ' Retry, or raise the run budget for long routes.',
    'not_determined',
    'budget-exhausted',
  );
}

/** Deadline expiry (cancellation) is also an honest not_determined. */
function notDeterminedDeadline(budget: UpstreamBudget, stats: RunProgressStats): PlanningError {
  return new PlanningError(
    `Plan not determined: the run exceeded its time budget (${budget.attemptsMade}` +
      ` of ${budget.maxAttempts} upstream attempts used) and was cancelled before the route could be verified.` +
      `${coverageEvidence(stats)} No plan was produced and no trip was saved; nothing here is verified.`,
    'not_determined',
    'deadline',
  );
}

/** Inner planning core: everything that runs inside the bounded budget. */
interface GuardHooks {
  /** Logical-dispatch reserve (fallback; real clients enforce per attempt). */
  reserveCall?: () => void;
  /** The shared run budget (coverage evidence on failure). */
  budget: UpstreamBudget;
  /** Progress stats updated by planCore for honest failure evidence. */
  stats: RunProgressStats;
  signal: AbortSignal;
}

async function planCore(
  deps: PlannerDeps,
  origin: { label: string; lat: number; lon: number },
  destination: { label: string; lat: number; lon: number },
  opts: Required<PlanOptions>,
  vehicle: VehicleConfig,
  vehicleMeta: PlanVehicleMeta,
  hooks: GuardHooks,
): Promise<PlanBundle> {
  /** Wrapper threads the deadline; budget enforcement lives in the client
   *  for real statiq deps (per transport attempt) or in reserveCall for
   *  duck-typed doubles (per logical dispatch). */
  const guardedStatiq = {
    markers: (lat: number, lon: number) => {
      hooks.reserveCall?.();
      return deps.statiq.markers(lat, lon, hooks.signal);
    },
    detailsWithMeta: (stationId: number) => {
      hooks.reserveCall?.();
      return deps.statiq.detailsWithMeta(stationId, hooks.signal);
    },
  };

  // 1) Fastest route (free OSRM).
  const route = await deps.router.route(origin, destination);
  const cum = cumulativeKm(route.geometry);
  const totalKm = cum[cum.length - 1] as number;

  // 2) Live corridor scan for candidate stations.
  const scanStartedAt = Date.now();
  const corridor = await scanCorridor(guardedStatiq, route.geometry, {
    maxOffRouteKm: opts.fallbackDetourKm,
    signal: hooks.signal,
    // INCREMENTAL SCAN PROGRESS: counters flow in per completed sample,
    // so a fatal stop MID-SCAN (first 429/auth, cap exhaustion, deadline)
    // still reports the actual samples completed/ok/failed in the
    // not_determined evidence (the plan arrives before any dispatch).
    // ADVISORY ONLY: progress reporting never gates execution - the owner
    // policy is every-candidate-checked, and the run proceeds until the
    // budget/deadline is hit (the derived estimate appears in the failure
    // evidence as rough reporting, nothing more).
    onProgress: (p) => {
      hooks.stats.samplesPlanned = p.planned;
      hooks.stats.samplesCompleted = p.completed;
      hooks.stats.samplesOk = p.ok;
      hooks.stats.samplesFailed = p.failed;
    },
  });
  const warnings: string[] = [...corridor.warnings];
  // Phase accounting (a completed scan reconciles to the same values the
  // incremental callbacks already carried; the plan-first report arrives
  // before any dispatch).
  hooks.stats.scanMs = Date.now() - scanStartedAt;
  hooks.stats.samplesPlanned = corridor.samplesPlanned;
  hooks.stats.samplesCompleted = corridor.samples + corridor.failedSamples.length;
  hooks.stats.samplesOk = corridor.samples;
  hooks.stats.samplesFailed = corridor.failedSamples.length;
  hooks.stats.candidatesPlanned = corridor.candidates.length;

  // FAIL CLOSED: persistent throttling or a scan with too many holes can
  // never be presented as a verified plan.
  const throttled = corridor.failedSamples.filter((f) => f.cause === 'throttled').length;
  const failedFrac =
    corridor.samplesPlanned > 0 ? corridor.failedSamples.length / corridor.samplesPlanned : 0;
  if (throttled > 0) {
    throw new PlanningError(
      'Plan not determined: the charger API is throttling requests (429).' +
        `${coverageEvidence(hooks.stats)} Nothing here is verified` +
        ' - please retry in a minute. No trip was saved.',
      'not_determined',
      'sample-throttled',
    );
  }
  if (failedFrac > 0.05) {
    throw new PlanningError(
      `Plan not determined: ${corridor.failedSamples.length} of ${corridor.samplesPlanned} route samples ` +
        'could not be scanned. Charger coverage is incomplete; refusing to present this as a verified plan.',
      'not_determined',
      'scan-coverage',
    );
  }

  // 3) Live details + CCS2 DC classification for EVERY corridor candidate.
  //    OWNER DIRECTIVE: individual per-station lookups with multiple checks
  //    in flight - every unique candidate is checked. There is NO bulk
  //    endpoint and NO window/candidate pruning: the whole unique pool
  //    (both detour bands) is looked up one station at a time, with a few
  //    lookups in flight so upstream latency can overlap the pacing gap.
  //    Selection still prefers the primary band and never detours far for a
  //    brand, but it CONSULTS every fetched candidate.
  //
  //    CONCURRENCY EVIDENCE (offline harness, Linux; latency shaped like the
  //    replica): at 40ms latency / 200ms gaps, 12 calls took ~2244ms with 3
  //    workers and ~2242ms with 100 (max 1 request actually in flight); at
  //    600ms latency 3 workers overlapped (~2955ms). Multiple checks in
  //    flight therefore help only when latency exceeds the gap - they never
  //    reduce the request count and never remove pacing: the limiter alone
  //    decides pace (25/60s + 2s are conservative PROJECT SAFETY DEFAULTS,
  //    not a provider contract).
  const detailCache = new Map<number, Candidate>();
  /** Candidates whose per-station lookup completed WITHOUT data (fetch
   *  error or a 200 with a null station): UNKNOWN - unlike known-unusable
   *  stations (all-faulted plugs), an unknown candidate could have been
   *  usable, so impossibility claims must respect it (see selection). */
  const unknownCandidates = new Set<number>();
  const fetchCandidate = async (c: CorridorCandidate): Promise<void> => {
    if (detailCache.has(c.stationId)) return;
    try {
      const { response, fetchedAt } = await guardedStatiq.detailsWithMeta(c.stationId);
      if (response.station) {
        detailCache.set(c.stationId, {
          candidate: c,
          summary: summarizeCcs2(response.station),
          view: toStationView(response.station, fetchedAt),
        });
        hooks.stats.candidatesDetailed = detailCache.size;
      } else {
        // 200 with a null station: data inconsistency - an unknown, not a
        // verdict; leave a visible hole instead of passing silently
        unknownCandidates.add(c.stationId);
        warnings.push(`Skipping "${c.name}" (${c.stationId}): the station returned no data.`);
      }
    } catch (err) {
      // run-fatal stops (budget gate, first throttle/auth) and deadline
      // aborts unwind the run; they are not per-candidate skips
      if (
        isAbortLike(err) ||
        err instanceof UpstreamRunStoppedError ||
        err instanceof StatiqRunFatalError
      ) {
        throw err;
      }
      unknownCandidates.add(c.stationId);
      warnings.push(`Skipping "${c.name}" (${c.stationId}): live details unavailable.`);
    }
    // processed counts every COMPLETED per-station lookup (fetched, empty
    // or skipped) - run-fatal unwinds do not reach this line.
    hooks.stats.candidatesProcessed += 1;
  };

  // The WHOLE unique pool, both detour bands: individual per-station
  // lookups through pMap(4) (multiple checks in flight, never a bulk
  // endpoint). pMap only lets latency overlap the pacing gap; the client's
  // limiter alone decides pace - request count and pacing are unchanged
  // by concurrency (see the offline evidence in the comment above).
  const CANDIDATE_FETCH_CONCURRENCY = 4;
  hooks.stats.detailsStartedAt = Date.now();
  await pMap(corridor.candidates, CANDIDATE_FETCH_CONCURRENCY, fetchCandidate);
  const usable: Candidate[] = [...detailCache.values()]
    .filter((r) => r.summary.isUsable)
    .sort((a, b) => a.candidate.chainageKm - b.candidate.chainageKm);

  // 4) Greedy stop selection with minimal-charge lookahead.
  let cursor: Cursor = {
    chainageKm: 0,
    detourKm: 0,
    socPct: opts.startSocPct,
    isOrigin: true,
  };
  const chosen: ChosenStop[] = [];
  let guard = 0;

  const destLegKm = Math.max(0, totalKm - cursor.chainageKm);
  if (usable.length === 0 && socAfterDriving(destLegKm, cursor.socPct, vehicle) < opts.minArrivalSocPct) {
    // IMPOSSIBILITY CLAIMS NEED COMPLETE KNOWLEDGE: any UNKNOWN candidate
    // (lookup failed / empty response) could have been the usable one, so
    // 'no usable station' cannot be certified over holes.
    if (unknownCandidates.size > 0) {
      throw new PlanningError(
        `Plan not determined: ${unknownCandidates.size} candidate charger lookups returned no data,` +
          ` so "no usable station on this route" cannot be certified over incomplete coverage.` +
          ' This is not a route verdict; no trip was saved. Retry.',
        'not_determined',
        'candidate-holes',
      );
    }
    throw new PlanningError(
      'No usable CCS2 DC charging stations were found along this route within the detour limit.',
      'no_route',
    );
  }

  while (
    socAfterDriving(
      Math.max(0, totalKm - cursor.chainageKm + cursor.detourKm),
      // a charging stop may charge before the final run; the origin cannot
      cursor.isOrigin ? cursor.socPct : opts.absoluteMaxSocPct,
      vehicle,
    ) < opts.minArrivalSocPct
  ) {
    if (++guard > 60) {
      throw new PlanningError(
        'Planner exceeded its stop budget; is the route chargeable at all?',
        'infeasible',
      );
    }
    let next = chooseNextStop(usable, cursor, opts, vehicle, warnings);
    if (!next) {
      // IMPOSSIBILITY CLAIMS NEED COMPLETE KNOWLEDGE of the window being
      // claimed: an UNKNOWN candidate inside (cursor, cursor+maxLeg] could
      // have covered this gap, so 'no charger within N km' cannot be
      // certified over a hole in exactly that window.
      const unknownInWindow = corridor.candidates.filter(
        (c) =>
          unknownCandidates.has(c.stationId) &&
          c.chainageKm > cursor.chainageKm + 1 &&
          c.chainageKm <= cursor.chainageKm + opts.maxLegKm,
      );
      if (unknownInWindow.length > 0) {
        throw new PlanningError(
          `Plan not determined: ${unknownInWindow.length} candidate charger${unknownInWindow.length === 1 ? '' : 's'} within the ` +
            `${opts.maxLegKm} km past the ${cursor.chainageKm.toFixed(0)} km mark returned no data,` +
            ' so this highway gap cannot be certified impossible over incomplete coverage.' +
            ' This is not a route verdict; no trip was saved. Retry.',
          'not_determined',
          'candidate-holes',
        );
      }
      throw new PlanningError(
        `No usable charger within ${opts.maxLegKm} km past the ${cursor.chainageKm.toFixed(0)} km mark. ` +
          `The highway gap exceeds the ${opts.maxLegKm} km safe running range.`,
        'infeasible',
      );
    }
    chosen.push(next);
    cursor = {
      chainageKm: next.cand.candidate.chainageKm,
      detourKm: next.cand.candidate.offRouteKm,
      // charge at the previous point covered this leg: arrive with the buffer
      socPct: next.arriveSocPct,
      isOrigin: false,
    };
  }

  const stops = finalize(chosen, totalKm, route, opts, vehicle, warnings);
  const totals = computeTotals(stops, totalKm, route, opts, vehicle);

  const status: PlanStatus = corridor.failedSamples.length > 0 ? 'degraded' : 'ok';
  const plan: TripPlan = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    origin,
    destination,
    vehicle: vehicleMeta,
    status,
    source: 'live',
    routeDistanceKm: route.distanceKm,
    routeDurationMin: route.durationMin,
    geometry: route.geometry,
    stops,
    totals,
    stationsSeen: corridor.stationsSeen,
    warnings,
    // AI flow only: candidate summary WITHOUT occupancy (usable plugs are
    // offered; the AI is never told which are occupied).
    ...(opts.includeCandidates
      ? { candidates: usable.map(toAiCandidate) }
      : {}),
  };
  return { plan, usableCandidates: usable, route };
}

/** AI-safe candidate projection: no plug occupancy, no health detail. */
function toAiCandidate(c: Candidate): PlanCandidate {
  return {
    stationId: c.candidate.stationId,
    name: c.view.name,
    brand: c.view.brand,
    chainageKm: round1(c.candidate.chainageKm),
    offRouteKm: round1(c.candidate.offRouteKm),
    city: c.view.city,
    rating: c.view.rating,
    reviewCount: c.view.reviewCount,
    maxKw: c.summary.maxKw,
    pricePerKwh: c.summary.pricePerKwh,
  };
}

/**
 * Pick the next stop from `cursor`:
 * candidates in (pos, pos+maxLegKm]; origin cursor must reach on its
 * current SoC, a station cursor may charge up to absoluteMaxSocPct first.
 */
function chooseNextStop(
  usable: Candidate[],
  cursor: Cursor,
  opts: Required<PlanOptions>,
  vehicle: VehicleConfig,
  warnings: string[],
): ChosenStop | null {
  const hop = (c: Candidate): { cand: Candidate; legKm: number } | null => {
    const legKm = legKmBetween(cursor, c.candidate.chainageKm, c.candidate.offRouteKm);
    if (legKm > opts.maxLegKm || legKm <= 1) return null;
    if (cursor.isOrigin) {
      // cannot charge before the first stop
      if (socAfterDriving(legKm, cursor.socPct, vehicle) < opts.minArrivalSocPct - 1e-6) return null;
      return { cand: c, legKm };
    }
    // charging at the cursor can cover the hop only up to the absolute max
    if (socAfterDriving(legKm, opts.absoluteMaxSocPct, vehicle) < opts.minArrivalSocPct - 1e-6) {
      return null;
    }
    return { cand: c, legKm };
  };

  const inWindow = usable
    .filter((c) => c.candidate.chainageKm > cursor.chainageKm + 1)
    .map(hop)
    .filter((x): x is { cand: Candidate; legKm: number } => x !== null);
  if (inWindow.length === 0) return null;

  let pool = inWindow.filter((x) => x.cand.candidate.offRouteKm <= opts.primaryDetourKm);
  if (pool.length === 0) {
    pool = inWindow;
    warnings.push(
      `All usable chargers past the ${cursor.chainageKm.toFixed(0)} km mark sit more than ${opts.primaryDetourKm} km off-route.`,
    );
  }

  // Prefer 250-300 km legs when they exist.
  const zone = pool.filter((x) => x.legKm >= opts.preferredLegMinKm && x.legKm <= opts.maxLegKm);
  const target = zone.length > 0 ? zone : pool;

  // Farthest progress first; brand preference in a tight cluster.
  const far = target.reduce((m, x) => (x.legKm > m.legKm ? x : m));
  const cluster = target
    .filter((x) => far.legKm - x.legKm <= opts.brandClusterKm)
    .sort((a, b) => {
      const br = BRAND_ORDER[a.cand.view.brand] - BRAND_ORDER[b.cand.view.brand];
      if (br !== 0) return br;
      const d = a.cand.candidate.offRouteKm - b.cand.candidate.offRouteKm;
      if (d !== 0) return d;
      const r = (a.cand.view.rating ?? 0) - (b.cand.view.rating ?? 0);
      if (r !== 0) return -r;
      const kw = (a.cand.summary.maxKw ?? 0) - (b.cand.summary.maxKw ?? 0);
      if (kw !== 0) return -kw;
      return a.cand.candidate.stationId - b.cand.candidate.stationId;
    }) as Array<{ cand: Candidate; legKm: number }>;

  const best = cluster[0];
  if (!best) return null;

  // Arrive SoC: charge at the cursor covers exactly this leg + buffer.
  const arriveSocPct = cursor.isOrigin
    ? socAfterDriving(best.legKm, cursor.socPct, vehicle)
    : opts.minArrivalSocPct + 2;
  return { cand: best.cand, legKm: best.legKm, arriveSocPct };
}

/** Per-stop charge/price/time numbers, consistent with the selection pass. */
export function finalize(
  chosen: ChosenStop[],
  totalKm: number,
  route: { distanceKm: number; durationMin: number },
  opts: Required<PlanOptions>,
  vehicle: VehicleConfig,
  warnings: string[],
): PlanStop[] {
  const stops: PlanStop[] = [];
  let etaMin = 0;

  for (let i = 0; i < chosen.length; i++) {
    const cur = chosen[i] as ChosenStop;
    const prev = i > 0 ? (chosen[i - 1] as ChosenStop) : undefined;
    const legKm = cur.legKm;
    const arriveSocPct = cur.arriveSocPct;

    // Charge at this stop covers the NEXT hop (or the final run to the destination).
    const nextChain = i + 1 < chosen.length ? (chosen[i + 1] as ChosenStop).cand.candidate.chainageKm : totalKm;
    const nextDetour = i + 1 < chosen.length ? (chosen[i + 1] as ChosenStop).cand.candidate.offRouteKm : 0;
    const nextLegKm =
      nextChain -
      cur.cand.candidate.chainageKm +
      cur.cand.candidate.offRouteKm +
      nextDetour;
    const neededSoc = socRequiredForArrival(nextLegKm, opts.minArrivalSocPct + 2, vehicle);

    if (neededSoc > opts.absoluteMaxSocPct + 1e-6) {
      throw new PlanningError(
        `The leg leaving "${cur.cand.view.name}" is ${nextLegKm.toFixed(0)} km; even a full charge cannot cover it safely.`,
      );
    }
    let leaveSoc = Math.max(arriveSocPct, Math.min(opts.maxSocPerStopPct, neededSoc));
    if (neededSoc > opts.maxSocPerStopPct) {
      leaveSoc = Math.min(opts.absoluteMaxSocPct, neededSoc);
      warnings.push(
        `Charging "${cur.cand.view.name}" to ${Math.round(leaveSoc)}% (above the usual ${opts.maxSocPerStopPct}%) to cover a long leg.`,
      );
    }

    const chargeKwh = Math.max(0, kwhForSocDelta(arriveSocPct, leaveSoc, vehicle));
    const chargerKw = cur.cand.summary.maxKw ?? 50;
    const chargeMin = chargeTimeMin(arriveSocPct, leaveSoc, chargerKw, vehicle);
    const pricePerKwh = cur.cand.summary.pricePerKwh;

    etaMin += legTimeMin(legKm, route);
    stops.push({
      station: cur.cand.view,
      chainageKm: round1(cur.cand.candidate.chainageKm),
      legKm: round1(legKm),
      detourKm: round1(cur.cand.candidate.offRouteKm),
      arriveSocPct: round1(arriveSocPct),
      leaveSocPct: round1(leaveSoc),
      chargeKwh: round1(chargeKwh),
      pricePerKwh,
      estPriceInr: pricePerKwh != null ? Math.round(chargeKwh * pricePerKwh) : null,
      chargeTimeMin: Math.round(chargeMin),
      arrivalEtaMin: Math.round(etaMin),
      departureEtaMin: Math.round(etaMin + chargeMin),
    });
    etaMin += chargeMin;
  }
  return stops;
}

/** Leg time proportional to OSRM's route estimate. */
function legTimeMin(legKm: number, route: { distanceKm: number; durationMin: number }): number {
  return route.distanceKm > 0 ? route.durationMin * (legKm / route.distanceKm) : 0;
}

export function computeTotals(
  stops: PlanStop[],
  totalKm: number,
  route: { distanceKm: number; durationMin: number },
  opts: Required<PlanOptions>,
  vehicle: VehicleConfig,
): PlanTotals {
  const chargeMin = stops.reduce((s, x) => s + x.chargeTimeMin, 0);
  const kwh = stops.reduce((s, x) => s + x.chargeKwh, 0);
  // A known subtotal is not a trip total: an unknown tariff is not free.
  const price = stops.length === 0 || stops.some((s) => s.estPriceInr == null)
    ? null
    : stops.reduce((s, x) => s + (x.estPriceInr ?? 0), 0);
  const last = stops.at(-1);
  const finalLegKm = last ? totalKm - last.chainageKm + last.detourKm : totalKm;
  const finalSoc = socAfterDriving(
    finalLegKm,
    last ? last.leaveSocPct : opts.startSocPct,
    vehicle,
  );
  return {
    distanceKm: totalKm,
    driveTimeMin: Math.round(route.durationMin),
    chargeTimeMin: Math.round(chargeMin),
    totalTimeMin: Math.round(route.durationMin + chargeMin),
    chargeKwh: round1(kwh),
    estPriceInr: price,
    finalSocPct: Math.round(finalSoc),
  };
}

/** Map a live Statiq station detail into the domain view (reliability: null). */
export function toStationView(
  s: StatiqStationDetail,
  fetchedAt: Date = new Date(),
): StationLiveView {
  return {
    stationId: s.stationId,
    name: s.name,
    brand: detectBrand(s.name),
    lat: s.lat,
    lon: s.lon,
    address: s.address,
    city: s.city,
    hours: s.hours,
    openText: s.openText,
    rating: s.rating ?? null,
    reviewCount: s.reviewCount ?? null,
    reliability: null, // public data has no verified reliability score
    fetchedAt: fetchedAt.toISOString(),
    amenities: s.amenities ?? [],
    stationUrl: s.stationUrl,
    navUrl: s.navUrl,
    chargers: (s.chargers ?? []).map((ch) => ({
      chargerId: ch.chargerId,
      name: ch.name,
      type: ch.type,
      kw: ch.kw,
      pricePerKwh: ch.pricePerKwh ?? null,
      lastUsedOn: ch.lastUsedOn ?? null,
      plugs: (ch.connectors ?? []).map((p) => {
        const { health, contradiction } = classifyPlug(p);
        return {
          connectorId: p.connectorId,
          type: p.type,
          health,
          contradiction,
        };
      }),
    })),
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
