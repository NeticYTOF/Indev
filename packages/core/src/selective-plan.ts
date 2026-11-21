/**
 * AI-first selective planning primitives.
 *
 * Discovery reuses the existing sampled corridor scan (no polygon shortcut,
 * no truncation claim). Hydration uses the same core provenance and
 * certification path as the legacy planner. Incomplete evidence is returned
 * as typed warnings, never silently upgraded to a usable charger.
 */
import { scanCorridor, type CorridorCandidate } from './corridor.js';
import { certifyCappedCharger, summarizeCcs2 } from './plugs.js';
import { toStationView } from './planner.js';
import { hasFreshProvenance } from './provenance.js';
import type { StatiqDetailsResponse } from './types.js';
import type { PlaceRef, PlanOptions, StationLiveView } from './plan-types.js';
import type { PlannerCandidate } from './planner.js';
import type { OsrmRouter } from './router.js';
import type { StatiqClient } from './statiq.js';
import type { ProviderFailureCollector } from './provider-failure.js';

export interface SelectiveDiscovery {
  route: { distanceKm: number; durationMin: number; geometry: Array<{ lat: number; lon: number }> };
  candidates: CorridorCandidate[];
  samplesPlanned: number;
  samplesCompleted: number;
  samplesOk: number;
  samplesFailed: number;
  warnings: string[];
}

export interface SelectiveDeps {
  router: OsrmRouter;
  statiq: StatiqClient;
  failureCollector?: ProviderFailureCollector;
}

/** Route + live light-marker discovery ONLY. No detail fetch happens here. */
export async function discoverSelective(
  deps: SelectiveDeps,
  origin: PlaceRef,
  destination: PlaceRef,
  opts: PlanOptions,
  signal?: AbortSignal,
  onProgress?: (completed: number, planned: number) => void,
): Promise<SelectiveDiscovery> {
  const route = await deps.router.route(origin, destination, signal, opts.via);
  const corridor = await scanCorridor(deps.statiq, route.geometry, {
    maxOffRouteKm: opts.fallbackDetourKm,
    signal,
    failureCollector: deps.failureCollector,
    onProgress: (p) => onProgress?.(p.completed, p.planned),
  });
  const warnings = [...corridor.warnings];
  if (corridor.failedSamples.length > 0) {
    warnings.push(
      `Route scan had ${corridor.failedSamples.length} of ${corridor.samplesPlanned} unread samples; ` +
      'charger inventory is incomplete, so no absence claim is permitted.',
    );
  }
  return {
    route,
    candidates: corridor.candidates,
    samplesPlanned: corridor.samplesPlanned,
    samplesCompleted: corridor.samples + corridor.failedSamples.length,
    samplesOk: corridor.samples,
    samplesFailed: corridor.failedSamples.length,
    warnings,
  };
}

interface Hydration {
  candidate: PlannerCandidate | null;
  warnings: string[];
}

/** Hydrate one tool-selected candidate through legacy certification. */
export function hydrateSelective(
  candidate: CorridorCandidate,
  response: StatiqDetailsResponse,
  fetchedAt: Date,
  maxChargerKw?: number,
): Hydration {
  const warnings: string[] = [];
  if (maxChargerKw !== undefined &&
      !(typeof maxChargerKw === 'number' && Number.isFinite(maxChargerKw) && maxChargerKw > 0)) {
    return { candidate: null, warnings: ['Invalid hard power cap; station not certified.'] };
  }
  if (!hasFreshProvenance(response) || response.ok !== true ||
      response.live === false || response.retained === true) {
    return { candidate: null, warnings: ['Station evidence was not fresh live data.'] };
  }
  const station = response.station;
  if (station == null || station.stationId !== candidate.stationId ||
      !Number.isFinite(station.lat) || !Number.isFinite(station.lon) ||
      Math.abs(station.lat - candidate.lat) > 0.001 ||
      Math.abs(station.lon - candidate.lon) > 0.001) {
    return { candidate: null, warnings: ['Station identity or coordinates did not match the on-route candidate.'] };
  }
  if (!Array.isArray(station.chargers) ||
      station.chargers.some((ch) => !Array.isArray(ch.connectors))) {
    return { candidate: null, warnings: ['Charger or connector evidence was missing.'] };
  }
  const cap = maxChargerKw ?? Number.MAX_VALUE;
  const certification = certifyCappedCharger(station, cap);
  if (certification.status !== 'selected' || !certification.selected) {
    warnings.push(certification.status === 'incomplete'
      ? 'Charger power evidence was incomplete; station remains unknown.'
      : 'No certified charger within the active power cap; station excluded.');
    return { candidate: null, warnings };
  }
  const summary = summarizeCcs2(station);
  const view: StationLiveView = toStationView(station, fetchedAt);
  return {
    candidate: {
      candidate,
      summary,
      view,
      selectedCharger: certification.selected,
    },
    warnings,
  };
}
