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
import { pMap } from './utils.js';
import { chargeTimeMin, kwhForSocDelta, socAfterDriving, socRequiredForArrival, HARIER_EV_75, type VehicleConfig } from './vehicle.js';
import type { StatiqClient } from './statiq.js';
import type { OsrmRouter } from './router.js';
import type { StatiqStationDetail } from './types.js';
import {
  DEFAULT_PLAN_OPTIONS,
  type PlanOptions,
  type PlanStop,
  type PlanTotals,
  type StationLiveView,
  type TripPlan,
} from './plan-types.js';

export interface PlannerDeps {
  router: OsrmRouter;
  statiq: StatiqClient;
  vehicle?: VehicleConfig;
}

interface Candidate {
  candidate: CorridorCandidate;
  summary: Ccs2Summary;
  view: StationLiveView;
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

export class PlanningError extends Error {
  constructor(message: string) {
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

export async function planTrip(
  deps: PlannerDeps,
  origin: { label: string; lat: number; lon: number },
  destination: { label: string; lat: number; lon: number },
  options: PlanOptions = {},
): Promise<TripPlan> {
  const opts = { ...DEFAULT_PLAN_OPTIONS, ...options };
  const vehicle = deps.vehicle ?? HARIER_EV_75;

  // 1) Fastest route (free OSRM).
  const route = await deps.router.route(origin, destination);
  const cum = cumulativeKm(route.geometry);
  const totalKm = cum[cum.length - 1] as number;

  // 2) Live corridor scan for candidate stations.
  const corridor = await scanCorridor(deps.statiq, route.geometry, {
    maxOffRouteKm: opts.fallbackDetourKm,
  });

  // 3) Live details + CCS2 DC classification per candidate.
  const resolved: Candidate[] = [];
  const warnings: string[] = [];
  await pMap(corridor.candidates, 6, async (c) => {
    try {
      const res = await deps.statiq.details(c.stationId);
      if (!res.station) return;
      resolved.push({
        candidate: c,
        summary: summarizeCcs2(res.station),
        view: toStationView(res.station),
      });
    } catch {
      warnings.push(`Skipping "${c.name}" (${c.stationId}): live details unavailable.`);
    }
  });
  resolved.sort((a, b) => a.candidate.chainageKm - b.candidate.chainageKm);
  const usable = resolved.filter((r) => r.summary.isUsable);

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
      throw new PlanningError('Planner exceeded its stop budget; is the route chargeable at all?');
    }
    const next = chooseNextStop(usable, cursor, opts, vehicle, warnings);
    if (!next) {
      throw new PlanningError(
        `No usable charger within ${opts.maxLegKm} km past the ${cursor.chainageKm.toFixed(0)} km mark. ` +
          `The highway gap exceeds the ${opts.maxLegKm} km safe running range.`,
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

  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    origin,
    destination,
    routeDistanceKm: route.distanceKm,
    routeDurationMin: route.durationMin,
    geometry: route.geometry,
    stops,
    totals,
    stationsSeen: corridor.stationsSeen,
    warnings,
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
function finalize(
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

function computeTotals(
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
export function toStationView(s: StatiqStationDetail): StationLiveView {
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
