/**
 * AI-first selective planning primitives.
 *
 * Discovery reuses the existing sampled corridor scan (no polygon shortcut,
 * no truncation claim). Hydration uses the same core provenance and
 * certification path as the legacy planner. Incomplete evidence is returned
 * as typed warnings, never silently upgraded to a usable charger.
 */
import { scanCorridor, type CorridorCandidate } from './corridor.js';
import { certifyCappedCharger, connectorSlug, isPlanningUsableConnector, summarizeCcs2 } from './plugs.js';
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
  onProgress?: (progress: { completed: number; planned: number; ok: number; failed: number }) => void,
): Promise<SelectiveDiscovery> {
  const route = await deps.router.route(origin, destination, signal, opts.via);
  const corridor = await scanCorridor(deps.statiq, route.geometry, {
    maxOffRouteKm: opts.fallbackDetourKm,
    signal,
    failureCollector: deps.failureCollector,
    onProgress: (p) => onProgress?.({ completed: p.completed, planned: p.planned, ok: p.ok, failed: p.failed }),
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

export type HydrationReason =
  | 'invalid_cap' | 'not_fresh' | 'identity_mismatch' | 'missing_evidence' | 'schema_invalid'
  | 'no_dc_charger' | 'no_ccs2_connector' | 'no_usable_ccs2'
  | 'unknown_power' | 'not_within_cap';

export interface Hydration {
  candidate: PlannerCandidate | null;
  /** Sanitized generic text for AI tool replies. */
  warnings: string[];
  /** Precise host-only codes; never sent to the model. */
  reasons: HydrationReason[];
}

/** Hydrate one tool-selected candidate through legacy certification. */
export function hydrateSelective(
  candidate: CorridorCandidate,
  response: StatiqDetailsResponse,
  fetchedAt: Date,
  maxChargerKw?: number,
): Hydration {
  const generic = 'Station was not certified.';
  const fail = (reasons: HydrationReason[]): Hydration =>
    ({ candidate: null, warnings: [generic], reasons });
  if (maxChargerKw !== undefined &&
      !(typeof maxChargerKw === 'number' && Number.isFinite(maxChargerKw) && maxChargerKw > 0)) {
    return fail(['invalid_cap']);
  }
  if (!hasFreshProvenance(response) || response.ok !== true ||
      response.live === false || response.retained === true) {
    return fail(['not_fresh']);
  }
  const station = response.station;
  if (station == null || station.stationId !== candidate.stationId ||
      !Number.isFinite(station.lat) || !Number.isFinite(station.lon) ||
      Math.abs(station.lat - candidate.lat) > 0.001 ||
      Math.abs(station.lon - candidate.lon) > 0.001) {
    return fail(['identity_mismatch']);
  }
  if (!Array.isArray(station.chargers) || station.chargers.length === 0) {
    return fail(['missing_evidence']);
  }
  for (const raw of station.chargers as unknown[]) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return fail(['schema_invalid']);
    const ch = raw as { chargerId?: unknown; name?: unknown; type?: unknown; kw?: unknown; connectors?: unknown };
    if (typeof ch.type !== 'string' || typeof ch.name !== 'string' ||
        typeof ch.chargerId !== 'number' || !Number.isSafeInteger(ch.chargerId) || ch.chargerId <= 0) {
      return fail(['schema_invalid']);
    }
    if (!(typeof ch.kw === 'number' || ch.kw === null)) return fail(['schema_invalid']);
    if (!Array.isArray(ch.connectors)) return fail(['missing_evidence']);
    for (const plug of ch.connectors) {
      if (plug == null || typeof plug !== 'object' || Array.isArray(plug)) return fail(['schema_invalid']);
      const p = plug as { type?: unknown; status?: unknown; note?: unknown };
      if (typeof p.type !== 'string' || typeof p.status !== 'string') return fail(['schema_invalid']);
      if (!(p.note === null || p.note === undefined || typeof p.note === 'string')) return fail(['schema_invalid']);
    }
  }
  const dc = station.chargers.filter((ch) => connectorSlug(ch.type) === 'dc');
  if (dc.length === 0) return fail(['no_dc_charger']);
  const ccs2 = dc.flatMap((ch) => ch.connectors.filter((p) => connectorSlug(p.type) === 'ccs2'));
  if (ccs2.length === 0) return fail(['no_ccs2_connector']);
  const usable = ccs2.filter((p) => isPlanningUsableConnector(p));
  if (usable.length === 0) return fail(['no_usable_ccs2']);
  const cap = maxChargerKw ?? Number.MAX_VALUE;
  const certification = certifyCappedCharger(station, cap);
  if (certification.status !== 'selected' || !certification.selected) {
    const reason: HydrationReason = certification.status === 'incomplete' ? 'unknown_power' : 'not_within_cap';
    return fail([reason]);
  }
  const summary = summarizeCcs2(station);
  const view: StationLiveView = toStationView(station, fetchedAt);
  return {
    candidate: { candidate, summary, view, selectedCharger: certification.selected },
    warnings: [],
    reasons: [],
  };
}
