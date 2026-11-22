/** Actual-road certification for the final selected trip sequence only. */
import { cumulativeKm, haversineKm, projectOntoPolyline, type Coords } from './geo.js';
import type { OsrmRouter, RouteResult } from './router.js';

export interface RouteLegStop {
  stationId: number;
  label: string;
  coords: Coords;
  chainageKm: number;
}
/** One energy leg: all road segments between charging events, via included. */
export interface CertifiedRouteLeg {
  fromLabel: string;
  toLabel: string;
  stationId: number | null;
  distanceKm: number;
  durationMin: number;
  geometry: Coords[];
}
export interface CertifiedRouteLegs {
  legs: CertifiedRouteLeg[];
  totalDistanceKm: number;
  totalDurationMin: number;
  geometry: Coords[];
}
export class RouteCertificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteCertificationError';
  }
}

interface Point extends RouteLegStop {
  kind: 'stop' | 'via';
}
interface Waypoint {
  label: string;
  coords: Coords;
  stationId: number | null;
  chainageKm: number;
}

function validCoords(p: unknown): p is Coords {
  return p != null && typeof p === 'object' && 'lat' in p && 'lon' in p &&
    typeof (p as Coords).lat === 'number' && Number.isFinite((p as Coords).lat) &&
    Math.abs((p as Coords).lat) <= 90 &&
    typeof (p as Coords).lon === 'number' && Number.isFinite((p as Coords).lon) &&
    Math.abs((p as Coords).lon) <= 180;
}
function validateRoute(result: RouteResult, from: Coords, to: Coords, label: string): void {
  if (!result || !Number.isFinite(result.distanceKm) || result.distanceKm < 0 ||
      !Number.isFinite(result.durationMin) || result.durationMin < 0 ||
      !Array.isArray(result.geometry) || result.geometry.length < 2 ||
      result.geometry.some((p) => !validCoords(p))) {
    throw new RouteCertificationError(`Invalid actual road result for ${label}.`);
  }
  const chordKm = haversineKm(from, to);
  if (result.distanceKm < chordKm - 0.05) {
    throw new RouteCertificationError(`Actual road distance is physically shorter than the endpoint separation for ${label}.`);
  }
  if (result.distanceKm > 0 && result.durationMin <= 0) {
    throw new RouteCertificationError(`Actual road duration is not positive for ${label}.`);
  }
    // Routed distance is authoritative; simplified geometry need not match road km.
  const first = result.geometry[0] as Coords;
  const last = result.geometry[result.geometry.length - 1] as Coords;
  if (haversineKm(first, from) > 1 || haversineKm(last, to) > 1) {
    throw new RouteCertificationError(`Actual road geometry for ${label} does not start/end at the certified waypoints.`);
  }
}
function projectOnSegment(p: Coords, a: Coords, b: Coords,
  chainA: number, chainB: number): { distanceKm: number; chainageKm: number } {
  const latScale = 111.32;
  const meanLat = ((a.lat + b.lat) / 2) * Math.PI / 180;
  const lonScale = latScale * Math.max(0.01, Math.cos(meanLat));
  const px = p.lon * lonScale, py = p.lat * latScale;
  const ax = a.lon * lonScale, ay = a.lat * latScale;
  const dx = (b.lon - a.lon) * lonScale, dy = (b.lat - a.lat) * latScale;
  const denom = dx * dx + dy * dy;
  const t = denom === 0 ? 0 : Math.min(1, Math.max(0,
    ((px - ax) * dx + (py - ay) * dy) / denom));
  const foot = { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) };
  return { distanceKm: haversineKm(p, foot), chainageKm: chainA + t * (chainB - chainA) };
}
function viaChainage(coords: Coords, geometry: Coords[], cum: number[], label: string): number {
  const projection = projectOntoPolyline(coords, geometry, cum);
  if (projection.distanceKm > 2) {
    throw new RouteCertificationError(`${label} is not on the certified route geometry.`);
  }
  const ambiguous = geometry.some((_, i) => {
    if (i === 0) return false;
    const alt = projectOnSegment(coords, geometry[i - 1] as Coords, geometry[i] as Coords,
      cum[i - 1] as number, cum[i] as number);
    return alt.distanceKm <= Math.max(0.5, projection.distanceKm + 0.1) &&
      Math.abs(alt.chainageKm - projection.chainageKm) > 1;
  });
  if (ambiguous) throw new RouteCertificationError(`${label} has ambiguous route position at a self-crossing.`);
  return projection.chainageKm;
}
function joinGeometry(all: Coords[], next: Coords[]): void {
  for (let i = all.length === 0 ? 0 : 1; i < next.length; i += 1) all.push(next[i] as Coords);
}

/** Route only origin -> ordered stops/via -> destination; aggregating via into energy legs. */
export async function certifySelectedRouteLegs(
  router: OsrmRouter,
  baseRoute: RouteResult,
  origin: Coords,
  destination: Coords,
  via: readonly Coords[],
  stops: readonly RouteLegStop[],
  signal?: AbortSignal,
): Promise<CertifiedRouteLegs> {
  signal?.throwIfAborted();
  if (stops.length > 12) throw new RouteCertificationError('A trip may certify at most 12 charging stops.');
  if (via.length > 5) throw new RouteCertificationError('A trip may certify at most 5 via points.');
  if (!validCoords(origin) || !validCoords(destination) || via.some((p) => !validCoords(p))) {
    throw new RouteCertificationError('Invalid trip waypoint coordinates.');
  }
  const seenStops = new Set<number>();
  for (const stop of stops) {
    if (!Number.isSafeInteger(stop.stationId) || stop.stationId <= 0 || seenStops.has(stop.stationId) ||
        !validCoords(stop.coords) || !Number.isFinite(stop.chainageKm)) {
      throw new RouteCertificationError('Invalid or duplicate charging stop in selected sequence.');
    }
    seenStops.add(stop.stationId);
  }
  for (let i = 1; i < stops.length; i += 1) {
    if ((stops[i] as RouteLegStop).chainageKm <= (stops[i - 1] as RouteLegStop).chainageKm + 1e-6) {
      throw new RouteCertificationError('Selected charging stops are not in forward route order.');
    }
  }
  const cum = cumulativeKm(baseRoute.geometry);
  const totalKm = cum.at(-1) ?? baseRoute.distanceKm;
  for (const stop of stops) {
    if (stop.chainageKm < 0 || stop.chainageKm > totalKm + 1e-6) {
      throw new RouteCertificationError(`Stop ${stop.stationId} has an unsupported route position.`);
    }
  }
  const viaPoints: Point[] = via.map((coords, i) => ({ stationId: -i - 1, label: `via ${i + 1}`,
    coords, chainageKm: viaChainage(coords, baseRoute.geometry, cum, `Via ${i + 1}`), kind: 'via' }));
  for (let i = 1; i < viaPoints.length; i += 1) {
    if ((viaPoints[i] as Point).chainageKm <= (viaPoints[i - 1] as Point).chainageKm + 1e-6) {
      throw new RouteCertificationError('Supplied via points are not in forward route order.');
    }
  }
  const ordered: Point[] = [...stops.map((s) => ({ ...s, kind: 'stop' as const })), ...viaPoints]
    .sort((a, b) => a.chainageKm - b.chainageKm);
  for (let i = 0; i < ordered.length; i += 1) {
    const current = ordered[i] as Point;
    if (i > 0 && current.chainageKm - (ordered[i - 1] as Point).chainageKm <= 1e-6) {
      throw new RouteCertificationError('Selected stops and via points have ambiguous route order.');
    }
  }
  const waypoints: Waypoint[] = [
    { label: 'origin', coords: origin, stationId: null, chainageKm: 0 },
    ...ordered.map((p) => ({ label: p.label, coords: p.coords,
      stationId: p.kind === 'stop' ? p.stationId : null, chainageKm: p.chainageKm })),
    { label: 'destination', coords: destination, stationId: null, chainageKm: totalKm },
  ];
  const segments: Array<{ from: Waypoint; to: Waypoint; route: RouteResult }> = [];
  if (stops.length === 0) {
    validateRoute(baseRoute, origin, destination, 'direct trip');
    segments.push({ from: waypoints[0] as Waypoint,
      to: waypoints[waypoints.length - 1] as Waypoint, route: baseRoute });
  } else {
    for (let i = 1; i < waypoints.length; i += 1) {
      const from = waypoints[i - 1] as Waypoint;
      const to = waypoints[i] as Waypoint;
      let routed: RouteResult;
      try {
        routed = await router.route(from.coords, to.coords, signal, [], { retries: 0 });
      } catch (err) {
        if (signal?.aborted) signal.throwIfAborted();
        throw new RouteCertificationError(`Actual road leg ${from.label} -> ${to.label} could not be certified: ${
          err instanceof Error ? err.message : String(err)}`);
      }
      signal?.throwIfAborted();
      validateRoute(routed, from.coords, to.coords, `${from.label} -> ${to.label}`);
      segments.push({ from, to, route: routed });
    }
  }
  const legs: CertifiedRouteLeg[] = [];
  const allGeometry: Coords[] = [];
  let current: { fromLabel: string; distanceKm: number; durationMin: number; geometry: Coords[] } | null = null;
  let totalDistanceKm = 0;
  let totalDurationMin = 0;
  let previousEnd: Coords | null = null;
  for (const segment of segments) {
    if (previousEnd !== null && haversineKm(previousEnd,
        segment.route.geometry[0] as Coords) > 0.002) {
      throw new RouteCertificationError('Certified road segments do not join at their waypoint.');
    }
    if (current === null) current = { fromLabel: segment.from.label,
      distanceKm: 0, durationMin: 0, geometry: [] };
    current.distanceKm += segment.route.distanceKm;
    current.durationMin += segment.route.durationMin;
    joinGeometry(current.geometry, segment.route.geometry);
    joinGeometry(allGeometry, segment.route.geometry);
    totalDistanceKm += segment.route.distanceKm;
    totalDurationMin += segment.route.durationMin;
    if (segment.to.stationId !== null || segment.to.label === 'destination') {
      legs.push({ fromLabel: current.fromLabel, toLabel: segment.to.label,
        stationId: segment.to.stationId, distanceKm: current.distanceKm,
        durationMin: current.durationMin, geometry: current.geometry });
      current = null;
    }
    previousEnd = segment.route.geometry[segment.route.geometry.length - 1] as Coords;
  }
  if (current !== null) throw new RouteCertificationError('Certified road sequence ended without a destination.');
  for (const stop of stops) {
    if (!legs.some((leg) => leg.stationId === stop.stationId)) {
      throw new RouteCertificationError(`Missing actual road certificate for station ${stop.stationId}.`);
    }
  }
  return { legs, totalDistanceKm, totalDurationMin, geometry: allGeometry };
}
