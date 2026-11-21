/** Advisory physics guidance only. Never a filter, certification, or road-spur proof. */
import { cumulativeKm, socAfterDriving, usableKwh, type Coords, type VehicleConfig } from '@indeev/core';

export interface GuidancePoint {
  stationId: number;
  chainageKm: number;
  offRouteKm: number;
}
export interface GuidanceOptions {
  startSocPct: number;
  minArrivalSocPct: number;
  absoluteMaxSocPct: number;
  maxLegKm: number;
}
export interface GuidanceItem { stationId: number; legEstKm: number }
export interface ReachabilityGuidance {
  version: string;
  advisoryOnly: true;
  caveat: string;
  routeDistanceKm: number;
  directDestinationReachable: boolean;
  initialReachKm: number;
  initialUncheckedCount: number;
  initialUnchecked: GuidanceItem[];
  chain: {
    stationIds: number[];
    cursorChainageKm: number;
    cursorDetourKm: number;
    destinationReachable: boolean;
  } | null;
  frontierUncheckedCount: number;
  frontierUnchecked: GuidanceItem[];
  uncheckedCandidateCount: number;
  certifiedChainCandidateCount: number;
}

interface State {
  id: number | null;
  chainage: number;
  detour: number;
  score: number;
  ids: number[];
}
const EPS = 1e-6;
const GUIDANCE_LIMIT = 20;

function validPoint(p: GuidancePoint): boolean {
  return p != null && Number.isSafeInteger(p.stationId) && p.stationId > 0 &&
    Number.isFinite(p.chainageKm) && p.chainageKm >= 0 &&
    Number.isFinite(p.offRouteKm) && p.offRouteKm >= 0;
}
function validInputs(routeKm: number, opts: GuidanceOptions, vehicle: VehicleConfig): boolean {
  return Number.isFinite(routeKm) && routeKm >= 0 &&
    [opts.startSocPct, opts.minArrivalSocPct, opts.absoluteMaxSocPct, opts.maxLegKm]
      .every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    opts.startSocPct >= 0 && opts.startSocPct <= 100 &&
    opts.minArrivalSocPct >= 0 && opts.absoluteMaxSocPct >= opts.minArrivalSocPct &&
    opts.absoluteMaxSocPct <= 100 && opts.maxLegKm > 0 &&
    vehicle != null && Number.isFinite(vehicle.batteryKwh) && vehicle.batteryKwh > 0 &&
    Number.isFinite(vehicle.usableFraction) && vehicle.usableFraction > 0 &&
    Number.isFinite(vehicle.whPerKm) && vehicle.whPerKm > 0;
}
function uniquePoints(points: readonly GuidancePoint[]): GuidancePoint[] {
  const seen = new Set<number>();
  const unique: GuidancePoint[] = [];
  for (const point of points) {
    if (!validPoint(point) || seen.has(point.stationId)) continue;
    seen.add(point.stationId);
    unique.push(point);
  }
  return unique.sort((a, b) => a.chainageKm - b.chainageKm || a.stationId - b.stationId);
}
function spreadPoints(points: readonly GuidancePoint[], limit: number,
  minKm: number, maxKm: number): GuidancePoint[] {
  const bands = Math.min(5, points.length);
  if (bands === 0) return [];
  const buckets: GuidancePoint[][] = Array.from({ length: bands }, () => []);
  const width = maxKm > minKm ? (maxKm - minKm) / bands : 1;
  for (const point of points) {
    const index = maxKm > minKm
      ? Math.min(bands - 1, Math.max(0, Math.floor((point.chainageKm - minKm) / width)))
      : 0;
    buckets[index]?.push(point);
  }
  const result: GuidancePoint[] = [];
  for (let round = 0; result.length < limit; round += 1) {
    let added = false;
    for (const bucket of buckets) {
      const point = bucket[round];
      if (point === undefined) continue;
      result.push(point);
      added = true;
      if (result.length >= limit) break;
    }
    if (!added) break;
  }
  return result;
}
function legKm(from: State, point: GuidancePoint): number {
  return point.chainageKm - from.chainage + from.detour + point.offRouteKm;
}
function canLeg(from: State, point: GuidancePoint, opts: GuidanceOptions,
  vehicle: VehicleConfig): boolean {
  if (from.id !== null && point.chainageKm <= from.chainage + EPS) return false;
  const leg = legKm(from, point);
  if (leg < -EPS || leg > opts.maxLegKm + EPS) return false;
  const depart = from.id === null ? opts.startSocPct : opts.absoluteMaxSocPct;
  return socAfterDriving(leg, depart, vehicle) >= opts.minArrivalSocPct - EPS;
}
function finalReachable(state: State, routeKm: number, opts: GuidanceOptions,
  vehicle: VehicleConfig): boolean {
  const leg = routeKm - state.chainage + state.detour;
  if (leg < -EPS || leg > opts.maxLegKm + EPS) return false;
  const depart = state.id === null ? opts.startSocPct : opts.absoluteMaxSocPct;
  return socAfterDriving(leg, depart, vehicle) >= opts.minArrivalSocPct - EPS;
}

export function buildReachabilityGuidance(
  routeKm: number,
  candidates: readonly GuidancePoint[],
  certified: readonly GuidancePoint[],
  checkedIds: ReadonlySet<number>,
  opts: GuidanceOptions,
  vehicle: VehicleConfig,
  geometry?: readonly Coords[],
): ReachabilityGuidance {
  const totalKm = geometry != null && geometry.length > 0
    ? cumulativeKm(geometry).at(-1) ?? routeKm : routeKm;
  const safeCandidates = uniquePoints(candidates);
  const safeCertified = uniquePoints(certified);
  const uncheckedCandidateCount = safeCandidates.filter((p) => !checkedIds.has(p.stationId)).length;
  if (!validInputs(totalKm, opts, vehicle)) {
    return {
      version: 'reachability-guidance-v1', advisoryOnly: true,
      caveat: 'Invalid inputs; no reachability claim is made.',
      routeDistanceKm: Number.isFinite(totalKm) ? Math.max(0, totalKm) : 0,
      directDestinationReachable: false, initialReachKm: 0,
      initialUncheckedCount: 0, initialUnchecked: [], chain: null,
      frontierUncheckedCount: 0, frontierUnchecked: [],
      uncheckedCandidateCount, certifiedChainCandidateCount: 0,
    };
  }
  const origin: State = { id: null, chainage: 0, detour: 0, score: 0, ids: [] };
  const energyKm = usableKwh(vehicle) *
    Math.max(0, opts.startSocPct - opts.minArrivalSocPct) / 100 /
    vehicle.whPerKm * 1000;
  const initialReachKm = Math.max(0, Math.min(opts.maxLegKm, energyKm));
  const frontierEnergyKm = usableKwh(vehicle) *
    Math.max(0, opts.absoluteMaxSocPct - opts.minArrivalSocPct) / 100 /
    vehicle.whPerKm * 1000;
  const frontierReachKm = Math.max(0, Math.min(opts.maxLegKm, frontierEnergyKm));
  const states = new Map<number, State>();
  for (const point of [...safeCertified].sort((a, b) => a.chainageKm - b.chainageKm)) {
    let best: State | null = null;
    for (const from of [origin, ...states.values()]) {
      if (!canLeg(from, point, opts, vehicle)) continue;
      const next: State = {
        id: point.stationId, chainage: point.chainageKm, detour: point.offRouteKm,
        score: point.chainageKm - point.offRouteKm, ids: [...from.ids, point.stationId],
      };
      if (best === null || next.score > best.score) best = next;
    }
    if (best !== null) states.set(point.stationId, best);
  }
  const ordered = [...states.values(), origin];
  const destinationStates = ordered.filter((s) => finalReachable(s, totalKm, opts, vehicle));
  const frontier = (destinationStates.length > 0 ? destinationStates : [...states.values()])
    .sort((a, b) => b.score - a.score)[0] ?? origin;
  const unchecked = safeCandidates
    .filter((p) => !checkedIds.has(p.stationId) && p.chainageKm > frontier.chainage + EPS);
  const initialUncheckedRaw = safeCandidates
    .filter((p) => !checkedIds.has(p.stationId) && canLeg(origin, p, opts, vehicle));
  const initialUnchecked = spreadPoints(initialUncheckedRaw, GUIDANCE_LIMIT, 0, initialReachKm);
  const frontierUncheckedRaw = unchecked.filter((p) => canLeg(frontier, p, opts, vehicle));
  const frontierItems = spreadPoints(
    frontierUncheckedRaw, GUIDANCE_LIMIT, frontier.chainage,
    Math.min(totalKm, frontier.chainage + frontierReachKm));
  return {
    version: 'reachability-guidance-v1',
    advisoryOnly: true,
    caveat: 'Marker chainage plus estimated off-route only; not proof of a drivable spur or charger eligibility.',
    routeDistanceKm: totalKm,
    directDestinationReachable: finalReachable(origin, totalKm, opts, vehicle),
    initialReachKm,
    initialUncheckedCount: initialUncheckedRaw.length,
    initialUnchecked: initialUnchecked.slice(0, GUIDANCE_LIMIT).map((p) => ({
      stationId: p.stationId, legEstKm: legKm(origin, p),
    })),
    chain: states.size === 0 && finalReachable(origin, totalKm, opts, vehicle) ? null : {
      stationIds: frontier.ids,
      cursorChainageKm: frontier.chainage,
      cursorDetourKm: frontier.detour,
      destinationReachable: finalReachable(frontier, totalKm, opts, vehicle),
    },
    frontierUncheckedCount: frontierUncheckedRaw.length,
    frontierUnchecked: frontierItems.slice(0, GUIDANCE_LIMIT).map((p) => ({
      stationId: p.stationId, legEstKm: legKm(frontier, p),
    })),
    uncheckedCandidateCount,
    certifiedChainCandidateCount: states.size,
  };
}
