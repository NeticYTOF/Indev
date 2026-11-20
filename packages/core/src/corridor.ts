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
  /**
   * Incremental scan progress: invoked synchronously once with the PLAN
   * (planned = N, completed = 0) and after EVERY completed sample (success
   * or failure). Callers carry honest counters even when the scan unwinds
   * fatally mid-way (fatal stops are rethrown, not recorded as sample
   * failures - but progress made before the stop is not lost). Completed
   * counts responses received - never a substitute for the separate
   * actual-attempt counter (budget attemptsMade).
   */
  onProgress?: (progress: CorridorScanProgress) => void;
}

export type SampleFailCause = 'throttled' | 'error';

/** Incremental scan progress (carried even through a fatal mid-scan stop). */
export interface CorridorScanProgress {
  /** Sample points planned for this scan (known before dispatching). */
  planned: number;
  /**
   * Samples COMPLETED so far: responses received (ok or failed).
   * In-flight samples and samples unwound by a fatal stop are NOT
   * completed and NOT counted here. This is a completion count, never a
   * dispatch count - actual upstream attempts are counted separately by
   * the run budget (reserved == dispatched).
   */
  completed: number;
  /** Samples that returned markers successfully. */
  ok: number;
  /** Samples that failed (any cause). */
  failed: number;
}

export interface SampleFailure {
  chainageKm: number;
  cause: SampleFailCause;
}

export interface CorridorResult {
  candidates: CorridorCandidate[];
  /** Marker calls that succeeded. */
  samples: number;
  /** Sample points planned for this scan (the scan plan; ok + failed
   *  count the COMPLETED responses once the scan returns). */
  samplesPlanned: number;
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
  onProgress?: (progress: CorridorScanProgress) => void;
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
  const { stepKm, maxOffRouteKm, concurrency, signal, onProgress } = {
    ...DEFAULTS,
    ...opts,
  } as ResolvedCorridorOptions;
  if (routeGeometry.length < 2) {
    return {
      candidates: [],
      samples: 0,
      samplesPlanned: 0,
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

  const report = (): void => {
    onProgress?.({
      planned: samplePoints.length,
      completed: okSamples + failedSamples.length,
      ok: okSamples,
      failed: failedSamples.length,
    });
  };
  // PLAN-FIRST: the caller knows the full sample plan (and can report
  // 'of N planned' evidence) even if the very first sample unwinds fatally.
  report();

  await pMap(samplePoints, concurrency, async (p, i) => {
    try {
      const res = await statiq.markers(p.lat, p.lon, signal);
      // Missing/non-array marker lists are coverage holes, not proof that
      // a sample has no chargers. Check before success counting so a bad
      // list cannot be counted as both completed successfully and failed.
      if (!res || res.ok !== true || !Array.isArray(res.stations)) {
        throw new Error('Invalid marker response');
      }
      let malformedMarker = false;
      for (const s of res.stations) {
        if (!s || typeof s !== 'object' || !Number.isSafeInteger(s.stationId) || s.stationId <= 0 ||
            typeof s.name !== 'string' ||
            typeof s.lat !== 'number' || !Number.isFinite(s.lat) || Math.abs(s.lat) > 90 ||
            typeof s.lon !== 'number' || !Number.isFinite(s.lon) || Math.abs(s.lon) > 180) {
          // Keep consuming valid records on BOTH sides of a malformed one.
          // Never allow bad coordinates to disappear as off-route evidence,
          // or a malformed duplicate to poison the deduplication map.
          malformedMarker = true;
          continue;
        }
        if (!seen.has(s.stationId)) seen.set(s.stationId, s);
      }
      if (malformedMarker) throw new Error('Invalid station marker evidence');
      // Consuming a malformed marker can fail too. Count success only
      // after consumption, so each completed sample has one outcome.
      okSamples++;
      report();
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
      report();
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
    samplesPlanned: samplePoints.length,
    stationsSeen: seen.size,
    failedSamples,
    warnings,
  };
}
