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
 * - Brand preference Statiq > Tata > BPCL > HP > others breaks ties only
 *   inside a small chainage cluster, never at the cost of an extra stop.
 * - Charger data is fetched live during this run and never persisted.
 */
import { cumulativeKm } from './geo.js';
import { scanCorridor, type CorridorCandidate } from './corridor.js';
import { classifyPlug, summarizeCcs2, type Ccs2Summary } from './plugs.js';
import { detectBrand } from './brands.js';
import { pMap, UpstreamBudgetError } from './utils.js';
import { chargeTimeMin, kwhForSocDelta, socAfterDriving, socRequiredForArrival, HARIER_EV_75, type VehicleConfig } from './vehicle.js';
import type { OsrmRouter } from './router.js';
import { isAbortLike, type StatiqClient } from './statiq.js';
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

export class PlanningError extends Error {
  /** Machine-readable outcome for UI/MCP: not_determined is never a plan. */
  constructor(
    message: string,
    readonly code:
      | 'not_determined'
      | 'no_route'
      | 'budget'
      | 'infeasible' = 'infeasible',
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

  // Bounded run: overall deadline + upstream-call budget, cancelled cleanly.
  const budget = opts.runBudget ?? DEFAULT_RUN_BUDGET;
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(),
    Math.max(50, budget.deadlineMs),
  );
  let upstreamCalls = 0;
  const countCall = () => {
    if (++upstreamCalls > budget.maxUpstreamCalls) {
      throw new UpstreamBudgetError(budget.maxUpstreamCalls);
    }
  };
  /** Guard wrapper: counts calls, enforces budget, and threads the deadline. */
  const guardedStatiq = {
    markers: (lat: number, lon: number) => {
      countCall();
      return deps.statiq.markers(lat, lon, deadlineController.signal);
    },
    detailsWithMeta: (stationId: number) => {
      countCall();
      return deps.statiq.detailsWithMeta(stationId, deadlineController.signal);
    },
  };

  try {
  const bundle = await planCore(deps, origin, destination, opts, vehicle, vehicleMeta, {
    countCall,
    signal: deadlineController.signal,
  });
  return bundle;
  } catch (err) {
  if (err instanceof PlanningError) throw err;
  if (err instanceof UpstreamBudgetError) {
    throw new PlanningError(
      `Planning stopped: the run exceeded its budget of ${budget.maxUpstreamCalls} upstream calls. ` +
        'No plan was produced; please retry.',
      'budget',
    );
  }
  if (isAbortLike(err)) {
    throw new PlanningError(
      'Planning stopped: the run exceeded its time budget and was cancelled. ' +
        'No plan was produced; please retry.',
      'budget',
    );
  }
  throw err;
  } finally {
  // Cancellation cleanup: never let a generous deadline hold the run.
  clearTimeout(deadlineTimer);
  // If the run is still in flight anywhere (exception paths), cancel it.
  deadlineController.abort();
  }
}

/** Inner planning core: everything that runs inside the bounded budget. */
interface GuardHooks {
  countCall: () => void;
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
  /** Guard wrapper: counts calls, enforces budget, and threads the deadline. */
  const guardedStatiq = {
    markers: (lat: number, lon: number) => {
      hooks.countCall();
      return deps.statiq.markers(lat, lon, hooks.signal);
    },
    detailsWithMeta: (stationId: number) => {
      hooks.countCall();
      return deps.statiq.detailsWithMeta(stationId, hooks.signal);
    },
  };

  // 1) Fastest route (free OSRM).
  const route = await deps.router.route(origin, destination);
  const cum = cumulativeKm(route.geometry);
  const totalKm = cum[cum.length - 1] as number;

  // 2) Live corridor scan for candidate stations.
  const corridor = await scanCorridor(guardedStatiq, route.geometry, {
    maxOffRouteKm: opts.fallbackDetourKm,
    signal: hooks.signal,
  });
  const warnings: string[] = [...corridor.warnings];

  // FAIL CLOSED: persistent throttling or a scan with too many holes can
  // never be presented as a verified plan.
  const throttled = corridor.failedSamples.filter((f) => f.cause === 'throttled').length;
  const failedFrac =
    corridor.samplesAttempted > 0 ? corridor.failedSamples.length / corridor.samplesAttempted : 0;
  if (throttled > 0) {
    throw new PlanningError(
      'Plan not determined: the charger API is throttling requests (429). ' +
        'Nothing here is verified - please retry in a minute. No trip was saved.',
      'not_determined',
    );
  }
  if (failedFrac > 0.05) {
    throw new PlanningError(
      `Plan not determined: ${corridor.failedSamples.length} of ${corridor.samplesAttempted} route samples ` +
        'could not be scanned. Charger coverage is incomplete; refusing to present this as a verified plan.',
      'not_determined',
    );
  }

  // 3) Live details + CCS2 DC classification.
  //    LIVE-EFFICIENCY (found via the bounded live acceptance): details are
  //    fetched EAGERLY only for candidates in the primary detour band
  //    (<= primaryDetourKm, where stops are actually chosen). The wider
  //    fallback band is fetched LAZILY - only when a selection window has
  //    no primary-band option - so a dense corridor no longer costs one
  //    details call per station along the whole route.
  const primaryBand = corridor.candidates.filter(
    (c) => c.offRouteKm <= opts.primaryDetourKm,
  );
  const fallbackBand = corridor.candidates.filter(
    (c) => c.offRouteKm > opts.primaryDetourKm,
  );
  const detailCache = new Map<number, Candidate>();
  const fetchCandidate = async (c: CorridorCandidate): Promise<void> => {
    if (detailCache.has(c.stationId)) return;
    try {
      const { response, fetchedAt } = await guardedStatiq.detailsWithMeta(c.stationId);
      if (!response.station) return;
      detailCache.set(c.stationId, {
        candidate: c,
        summary: summarizeCcs2(response.station),
        view: toStationView(response.station, fetchedAt),
      });
    } catch (err) {
      // deadline/budget cancellations unwind the run; they are not skips
      if (isAbortLike(err) || (err instanceof PlanningError && err.code === 'budget')) throw err;
      warnings.push(`Skipping "${c.name}" (${c.stationId}): live details unavailable.`);
    }
  };

  await pMap(primaryBand, 3, fetchCandidate);
  const usableCandidates = (): Candidate[] =>
    [...detailCache.values()]
      .filter((r) => r.summary.isUsable)
      .sort((a, b) => a.candidate.chainageKm - b.candidate.chainageKm);
  let usable = usableCandidates();

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
      // No primary-band option in this window: fetch the fallback band for
      // THIS window on demand (lazy), then retry the selection once.
      const windowBand = fallbackBand.filter(
        (c) =>
          c.chainageKm > cursor.chainageKm + 1 &&
          c.chainageKm <= cursor.chainageKm + opts.maxLegKm &&
          !detailCache.has(c.stationId),
      );
      if (windowBand.length > 0) {
        await pMap(windowBand, 3, fetchCandidate);
        usable = usableCandidates();
        next = chooseNextStop(usable, cursor, opts, vehicle, warnings);
      }
    }
    if (!next) {
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
  const price = stops.every((s) => s.estPriceInr == null)
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
