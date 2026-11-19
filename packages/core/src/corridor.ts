/**
 * Corridor scanning: fetch live stations along a route.
 *
 * The markers endpoint covers ~13 km around a point, so we sample the route
 * every `stepKm` (12 km, with overlap) and dedupe by stationId. Stations are
 * projected onto the route to get chainage (position along the route) and
 * perpendicular detour distance.
 *
 * Nothing is persisted: candidates live only for the current planning run.
 *
 * FAIL-CLOSED INTEGRITY: every failed sample is recorded with its cause.
 * Persistent throttling (429) never produces a confident-looking result:
 * the planner turns those into a "plan not determined" outcome. Run-fatal
 * errors (budget gate, first throttle/auth stop, abort-like deadline
 * cancellation) are rethrown immediately, never swallowed as
 * "skipped samples".
 */
import { cumulativeKm, pointAtChainage, projectOntoPolyline, type Coords } from './geo.js';
import { pMap } from './utils.js';
import { isAbortLike, StatiqApiError, StatiqRunFatalError } from './statiq.js';
import { UpstreamRunStoppedError } from './upstream-budget.js';
import type { StatiqMarker, StatiqMarkersResponse } from './types.js';

/** The marker-fetching surface the corridor needs (for guards in tests). */
export interface MarkerSource {
  markers(lat: number, lon: number, signal?: AbortSignal): Promise<StatiqMarkersResponse>;
}

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
  /** Cancels the scan (run deadline / budget). */
  signal?: AbortSignal;
}

export type SampleFailCause = 'throttled' | 'error';

export interface SampleFailure {
  chainageKm: number;
  cause: SampleFailCause;
}

export interface CorridorResult {
  candidates: CorridorCandidate[];
  /** Marker calls that succeeded. */
  samples: number;
  /** Marker calls attempted. */
  samplesAttempted: number;
  /** Unique stations seen in this run (before off-route filtering). */
  stationsSeen: number;
  /** Per-sample failures with causes (throttling fails CLOSED upstream). */
  failedSamples: SampleFailure[];
  /** Human-readable warnings for non-fatal holes. */
  warnings: string[];
}

interface ResolvedCorridorOptions {
  stepKm: number;
  maxOffRouteKm: number;
  concurrency: number;
  signal?: AbortSignal;
}

const DEFAULTS: ResolvedCorridorOptions = {
  stepKm: 12,
  maxOffRouteKm: 5,
  // Multiple marker checks in flight: lets upstream latency overlap the
  // pacing gap. It does NOT reduce the request count and does NOT remove
  // pacing - the shared 25/60s + 2s limiter (project safety defaults,
  // not a provider contract) alone decides pace.
  concurrency: 4,
};

export async function scanCorridor(
  statiq: MarkerSource,
  routeGeometry: readonly Coords[],
  opts: CorridorOptions = {},
): Promise<CorridorResult> {
  const { stepKm, maxOffRouteKm, concurrency, signal } = { ...DEFAULTS, ...opts } as ResolvedCorridorOptions;
  if (routeGeometry.length < 2) {
    return {
      candidates: [],
      samples: 0,
      samplesAttempted: 0,
      stationsSeen: 0,
      failedSamples: [],
      warnings: [],
    };
  }
  const cum = cumulativeKm(routeGeometry);
  const totalKm = cum[cum.length - 1] as number;

  const samplePoints: Coords[] = [];
  const sampleChainages: number[] = [];
  for (let d = 0; d < totalKm; d += stepKm) {
    samplePoints.push(pointAtChainage(routeGeometry, cum, d));
    sampleChainages.push(d);
  }
  samplePoints.push(pointAtChainage(routeGeometry, cum, totalKm)); // destination end
  sampleChainages.push(totalKm);

  const seen = new Map<number, StatiqMarker>();
  const failedSamples: SampleFailure[] = [];
  const warnings: string[] = [];
  let okSamples = 0;

  await pMap(samplePoints, concurrency, async (p, i) => {
    try {
      const res = await statiq.markers(p.lat, p.lon, signal);
      okSamples++;
      for (const s of res.stations ?? []) {
        if (!seen.has(s.stationId)) seen.set(s.stationId, s);
      }
    } catch (err) {
      // Run-fatal errors unwind the whole run; they must never masquerade
      // as skipped samples (budget gate, first throttle/auth, deadlines).
      if (
        isAbortLike(err) ||
        err instanceof UpstreamRunStoppedError ||
        err instanceof StatiqRunFatalError
      ) {
        throw err;
      }
      const cause: SampleFailCause =
        err instanceof StatiqApiError && (err.status === 429 || err.status === 400 && err.body.includes('wait'))
          ? 'throttled'
          : 'error';
      failedSamples.push({ chainageKm: sampleChainages[i] ?? 0, cause });
      // A failed sample leaves a partial blind spot (neighbouring samples
      // overlap ~half of it): carry on for now, but record the hole honestly.
      warnings.push(
        `Charger scan could not read the sample near ${(sampleChainages[i] ?? 0).toFixed(0)} km (${cause === 'throttled' ? 'the charger API is throttling requests' : 'upstream unavailable'}); coverage there may be partial.`,
      );
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
  return {
    candidates,
    samples: okSamples,
    samplesAttempted: samplePoints.length,
    stationsSeen: seen.size,
    failedSamples,
    warnings,
  };
}
