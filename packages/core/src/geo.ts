/**
 * Geo maths for route planning: distances, polyline chainage,
 * and point-to-route projections on a spherical-Earth approximation.
 */

export interface Coords {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_KM = 6371;
const KM_PER_DEGREE_LAT = 111.32;

export function haversineKm(a: Coords, b: Coords): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Local equirectangular projection around `origin`, good for short
 * distances (tens of km) at Indian latitudes.
 */
function project(p: Coords, origin: Coords): { x: number; y: number } {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  return { x: p.lon * cosLat * KM_PER_DEGREE_LAT, y: p.lat * KM_PER_DEGREE_LAT };
}

/** Perpendicular-ish distance from `p` to segment `a`-`b`, in km. */
export function pointToSegmentKm(p: Coords, a: Coords, b: Coords): number {
  const origin = p;
  const pp = project(p, origin);
  const pa = project(a, origin);
  const pb = project(b, origin);
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return haversineKm(p, a);
  // clamp t to [0,1] so the distance is to the segment, not the infinite line
  const t = Math.max(0, Math.min(1, ((pp.x - pa.x) * dx + (pp.y - pa.y) * dy) / len2));
  const cx = pa.x + t * dx;
  const cy = pa.y + t * dy;
  return Math.hypot(pp.x - cx, pp.y - cy);
}

/** Perpendicular distance from `p` to a polyline, in km. */
export function pointToPolylineKm(p: Coords, polyline: readonly Coords[]): number {
  if (polyline.length === 0) return Number.POSITIVE_INFINITY;
  if (polyline.length === 1) return haversineKm(p, polyline[0] as Coords);
  let min = Number.POSITIVE_INFINITY;
  for (let i = 1; i < polyline.length; i++) {
    const d = pointToSegmentKm(p, polyline[i - 1] as Coords, polyline[i] as Coords);
    if (d < min) min = d;
  }
  return min;
}

/** Cumulative distance along a polyline, in km. Returns polyline.length entries (first is 0). */
export function cumulativeKm(polyline: readonly Coords[]): number[] {
  const cum = new Array<number>(polyline.length);
  cum[0] = 0;
  for (let i = 1; i < polyline.length; i++) {
    cum[i] = cum[i - 1] as number + haversineKm(polyline[i - 1] as Coords, polyline[i] as Coords);
  }
  return cum;
}

export interface RouteProjection {
  /** Perpendicular distance from the point to the route, km. */
  distanceKm: number;
  /** Distance along the route to the projection foot point, km. */
  chainageKm: number;
  /** Index of the segment whose projection is nearest. */
  segmentIndex: number;
}

/** Project a point onto a polyline: nearest foot point, its chainage, and distance to route. */
export function projectOntoPolyline(
  p: Coords,
  polyline: readonly Coords[],
  cum?: number[],
): RouteProjection {
  if (polyline.length === 0) {
    throw new Error('projectOntoPolyline: empty polyline');
  }
  if (polyline.length === 1) {
    return { distanceKm: haversineKm(p, polyline[0] as Coords), chainageKm: 0, segmentIndex: 0 };
  }
  const cumKm = cum ?? cumulativeKm(polyline);
  const origin = p;
  const pp = project(p, origin);
  let best = { distanceKm: Number.POSITIVE_INFINITY, chainageKm: 0, segmentIndex: 0 };
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1] as Coords;
    const b = polyline[i] as Coords;
    const pa = project(a, origin);
    const pb = project(b, origin);
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((pp.x - pa.x) * dx + (pp.y - pa.y) * dy) / len2));
    const dist = Math.hypot(pp.x - (pa.x + t * dx), pp.y - (pa.y + t * dy));
    if (dist < best.distanceKm) {
      const segStart = cumKm[i - 1] as number;
      const segLen = (cumKm[i] as number) - segStart;
      best = {
        distanceKm: dist,
        chainageKm: segStart + t * segLen,
        segmentIndex: i - 1,
      };
    }
  }
  return best;
}

/** Interpolate a point at a given chainage along a polyline. */
export function pointAtChainage(
  polyline: readonly Coords[],
  cum: readonly number[],
  chainageKm: number,
): Coords {
  if (polyline.length === 0) throw new Error('pointAtChainage: empty polyline');
  const total = cum[cum.length - 1] as number;
  if (chainageKm <= 0) return polyline[0] as Coords;
  if (chainageKm >= total) return polyline[polyline.length - 1] as Coords;
  // binary search for the segment containing chainage
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((cum[mid] as number) <= chainageKm) lo = mid;
    else hi = mid;
  }
  const segLen = (cum[hi] as number) - (cum[lo] as number);
  const t = segLen === 0 ? 0 : (chainageKm - (cum[lo] as number)) / segLen;
  const a = polyline[lo] as Coords;
  const b = polyline[hi] as Coords;
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}
