/**
 * Corridor scanning: fetch live stations along a route.
 *
 * The markers endpoint covers ~13 km around a point, so we sample the route
 * every `stepKm` (12 km, with overlap) and dedupe by stationId. Stations are
 * projected onto the route to get chainage (position along the route) and
 * perpendicular detour distance.
 *
 * Nothing is persisted: candidates live only for the current planning run.
 */
import { cumulativeKm, pointAtChainage, projectOntoPolyline, type Coords } from './geo.js';
import { pMap } from './utils.js';
import type { StatiqClient } from './statiq.js';
import type { StatiqMarker } from './types.js';

export interface CorridorCandidate {
  stationId: number;
  name: string;
  lat: number;
  lon: number;
  /** Position along the route, km from origin. */
  chainageKm: number;
  /** Straight-line distance from the route line, km. */
  offRouteKm: number;
  marker: StatiqMarker;
}

export interface CorridorOptions {
  /** Sampling step along the route (must be < the ~13 km marker radius). */
  stepKm?: number;
  /** Max perpendicular distance for a station to be considered. */
  maxOffRouteKm?: number;
  /** Concurrent marker requests. */
  concurrency?: number;
}

export interface CorridorResult {
  candidates: CorridorCandidate[];
  /** Marker calls made (for diagnostics). */
  samples: number;
  /** Unique stations seen in this run (before off-route filtering). */
  stationsSeen: number;
}

const DEFAULTS: Required<CorridorOptions> = {
  stepKm: 12,
  maxOffRouteKm: 5,
  concurrency: 4,
};

export async function scanCorridor(
  statiq: StatiqClient,
  routeGeometry: readonly Coords[],
  opts: CorridorOptions = {},
): Promise<CorridorResult> {
  const { stepKm, maxOffRouteKm, concurrency } = { ...DEFAULTS, ...opts };
  if (routeGeometry.length < 2) {
    return { candidates: [], samples: 0, stationsSeen: 0 };
  }
  const cum = cumulativeKm(routeGeometry);
  const totalKm = cum[cum.length - 1] as number;

  const samplePoints: Coords[] = [];
  for (let d = 0; d < totalKm; d += stepKm) {
    samplePoints.push(pointAtChainage(routeGeometry, cum, d));
  }
  samplePoints.push(pointAtChainage(routeGeometry, cum, totalKm)); // destination end

  const seen = new Map<number, StatiqMarker>();
  await pMap(samplePoints, concurrency, async (p) => {
    const res = await statiq.markers(p.lat, p.lon);
    for (const s of res.stations ?? []) {
      if (!seen.has(s.stationId)) seen.set(s.stationId, s);
    }
  });

  const candidates: CorridorCandidate[] = [];
  for (const m of seen.values()) {
    const proj = projectOntoPolyline({ lat: m.lat, lon: m.lon }, routeGeometry, cum);
    if (proj.distanceKm <= maxOffRouteKm) {
      candidates.push({
        stationId: m.stationId,
        name: m.name,
        lat: m.lat,
        lon: m.lon,
        chainageKm: proj.chainageKm,
        offRouteKm: proj.distanceKm,
        marker: m,
      });
    }
  }
  candidates.sort((a, b) => a.chainageKm - b.chainageKm);
  return { candidates, samples: samplePoints.length, stationsSeen: seen.size };
}
