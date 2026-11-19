/**
 * MCP tool handlers: plan_trip, list_saved_trips, get_station.
 *
 * Invariants (spec):
 * - Saved trips are SHARED with the website (same store file semantics:
 *   `saved-trips.json`, or `saved-trips.mock.json` under INDEV_MOCK).
 * - get_station offers usable CCS2 plugs WITHOUT telling the AI occupancy;
 *   uncertain/faulted plug counts stay visible (honesty), statuses never.
 * - Every planning run: fresh StatiqClient, bounded by deadline + call
 *   budget, sanitized audit entries, counters incremented by stations seen.
 */
import {
  CountersStore,
  recordPlanCounter,
  OsrmRouter,
  PhotonGeocoder,
  PlanningError,
  StatiqClient,
  TripsStore,
  VehicleSelectionError,
  planTrip,
  resolveVehicle,
  summarizeCcs2,
  toSavedTrip,
  type PlanRunBudget,
  type ResolvedVehicle,
  type SavedTrip,
  type TripPlan,
  type UpstreamAuditEntry,
  type VehicleSelection,
} from '@indeev/core';

const MCP_RUN_BUDGET: PlanRunBudget = { deadlineMs: 4 * 60_000, maxUpstreamCalls: 200 };

export interface McpToolDeps {
  createStatiq: () => StatiqClient;
  router: OsrmRouter;
  geocoder: PhotonGeocoder;
  trips: TripsStore;
  counters: CountersStore;
  mock: boolean;
  /** Sanitized audit sink (console by default in index.ts). */
  onUpstreamCall?: (entry: UpstreamAuditEntry) => void;
}

export interface PlanTripArgs {
  origin: string;
  destination: string;
  /** "489" real-world km for the selected vehicle (REQUIRED unless default Harrier). */
  vehicleRealWorldRangeKm?: number;
  vehicleCatalogId?: string;
  customVehicle?: { label?: string; batteryKwh: number; claimedRangeKwh?: number; realWorldRangeKm: number };
  startSocPct?: number;
  /** Optional trip name: plan is saved to the shared store when provided. */
  save?: string;
}

export interface PlanTripResult {
  summary: string;
  plan: TripPlan;
  savedTripId?: string;
}

/** Accepts "28.6139,77.209" or a free-text place resolved via geocoding. */
async function resolvePlace(
  geocoder: PhotonGeocoder,
  input: string,
): Promise<{ label: string; lat: number; lon: number }> {
  const trimmed = input.trim();
  const coordMatch = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(trimmed);
  if (coordMatch) {
    const lat = Number(coordMatch[1]);
    const lon = Number(coordMatch[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      return { label: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, lat, lon };
    }
  }
  const hits = await geocoder.search(trimmed, 1);
  const hit = hits[0];
  if (!hit) {
    throw new PlanningError(`Could not find a place matching "${trimmed}".`, 'no_route');
  }
  return { label: hit.label, lat: hit.lat, lon: hit.lon };
}

export async function planTripHandler(
  deps: McpToolDeps,
  args: PlanTripArgs,
): Promise<PlanTripResult> {
  if (deps.mock) {
    throw new PlanningError(
      'Live planning is unavailable while the MCP server runs in mock mode (INDEV_MOCK=1). Restart without mock for real plans.',
      'no_route',
    );
  }

  const origin = await resolvePlace(deps.geocoder, args.origin);
  const destination = await resolvePlace(deps.geocoder, args.destination);

  // Vehicle: real-world range is a user input, never derived from claims.
  const selection: VehicleSelection = {};
  let hasSelection = false;
  if (args.customVehicle) {
    selection.custom = args.customVehicle;
    hasSelection = true;
  } else if (args.vehicleCatalogId) {
    selection.entryId = args.vehicleCatalogId;
    if (args.vehicleRealWorldRangeKm != null) {
      selection.realWorldRangeKm = args.vehicleRealWorldRangeKm;
    }
    hasSelection = true;
  }
  let resolved: ResolvedVehicle;
  try {
    resolved = resolveVehicle(hasSelection ? selection : undefined);
  } catch (err) {
    if (err instanceof VehicleSelectionError) throw err;
    throw err;
  }

  const statiq = deps.createStatiq();
  const plan = await planTrip(
    {
      router: deps.router,
      statiq,
      vehicle: resolved.config,
      resolvedVehicle: resolved,
    },
    origin,
    destination,
    {
      startSocPct: args.startSocPct != null ? Math.min(100, Math.max(5, args.startSocPct)) : undefined,
      runBudget: MCP_RUN_BUDGET,
    },
  );

  // Running chargers-seen count only; no station data ever persisted.
  await recordPlanCounter(deps.counters, plan);

  let savedTripId: string | undefined;
  if (args.save?.trim()) {
    const saved = await deps.trips.save(plan, args.save.trim());
    savedTripId = saved.id;
  }

  return { summary: summarizePlan(plan), plan, savedTripId };
}

export function summarizePlan(plan: TripPlan): string {
  const lines: string[] = [];
  lines.push(
    `${plan.origin.label} -> ${plan.destination.label}: ${Math.round(plan.routeDistanceKm)} km, ` +
      `${Math.round(plan.totals.totalTimeMin)} min total, ${plan.stops.length} charging stop${plan.stops.length === 1 ? '' : 's'}, ` +
      `Rs. ${plan.totals.estPriceInr != null ? Math.round(plan.totals.estPriceInr).toLocaleString('en-IN') : 'n/a'}, ` +
      `arrival charge ${Math.round(plan.totals.finalSocPct)}%.`,
  );
  plan.stops.forEach((s, i) => {
    lines.push(
      `  Stop ${i + 1}: ${s.station.name} (${s.station.brand}) at ${Math.round(s.chainageKm)} km, ` +
        `charge ${s.arriveSocPct}% -> ${s.leaveSocPct}% (+${Math.round(s.chargeKwh)} kWh, ` +
        `Rs. ${s.estPriceInr != null ? Math.round(s.estPriceInr) : 'n/a'}, ${s.chargeTimeMin} min), ` +
        `tariff ${s.pricePerKwh != null ? `Rs. ${s.pricePerKwh}/kWh` : 'unknown'}, ` +
        `rating ${s.station.rating ?? 'n/a'} (${s.station.reviewCount ?? 0} reviews).`,
    );
  });
  for (const w of plan.warnings) {
    lines.push(`  Note: ${w}`);
  }
  return lines.join('\n');
}

export interface SavedTripSummary {
  id: string;
  name: string;
  route: string;
  distanceKm: number;
  stops: number;
  totalTimeMin: number;
  status: string;
  source: string;
  createdAt: string;
}

export async function listSavedTripsHandler(deps: McpToolDeps): Promise<{
  count: number;
  trips: SavedTripSummary[];
  summary: string;
}> {
  const trips: SavedTrip[] = await deps.trips.list();
  const mapped = trips.map((t) => ({
    id: t.id,
    name: t.name,
    route: `${t.origin.label} -> ${t.destination.label}`,
    distanceKm: t.routeDistanceKm,
    stops: t.stations.length,
    totalTimeMin: t.totals.totalTimeMin,
    status: t.status,
    source: t.source,
    createdAt: t.createdAt,
  }));
  const summary =
    mapped.length === 0
      ? 'No saved trips yet.'
      : `Saved trips (${mapped.length}):\n` +
        mapped.map((t) => `- ${t.name}: ${t.route}, ${Math.round(t.distanceKm)} km, ${t.stops} stop(s), ${Math.round(t.totalTimeMin)} min [${t.source}/${t.status}]`).join('\n');
  return { count: mapped.length, trips: mapped, summary };
}

export interface StationViewMcp {
  stationId: number;
  name: string;
  city: string | null;
  hours: string | null;
  openText: string | null;
  rating: number | null;
  reviewCount: number | null;
  /** Always null: no verified reliability score exists in public data. */
  reliability: null;
  lastUsedOn: string | null;
  /** Usable CCS2 DC plugs (occupied ones included; occupancy never told). */
  ccs2Usable: number;
  /** Honesty counters: unusable and uncertain plugs stay visible. */
  ccs2Uncertain: number;
  ccs2Faulted: number;
  ccs2Offline: number;
  maxKw: number | null;
  pricePerKwh: number | null;
  fetchedAt: string;
  synthetic: boolean;
}

export async function getStationHandler(
  deps: McpToolDeps,
  stationId: number,
): Promise<{ summary: string; station: StationViewMcp }> {
  if (deps.mock) {
    throw new PlanningError(
      'Live station details are unavailable while the MCP server runs in mock mode (INDEV_MOCK=1).',
      'not_determined',
    );
  }
  // Always a FRESH client: station status is never served from a memo.
  const statiq = deps.createStatiq();
  const { response, fetchedAt } = await statiq.detailsWithMeta(stationId);
  // Match HTTP/planner integrity: never publish another station's plugs
  // or treat missing lists as confirmed absence of usable connectors.
  if (!response || response.ok !== true ||
      (response.station && (response.station.stationId !== stationId ||
        !Array.isArray(response.station.chargers) ||
        response.station.chargers.some((charger) => !charger || !Array.isArray(charger.connectors))))) {
    throw new PlanningError('Station details could not be verified. Please retry.', 'not_determined');
  }
  if (!response.station) {
    throw new PlanningError(`Station ${stationId} not found.`, 'no_route');
  }
  const s = response.station;
  const summary = summarizeCcs2(s);

  const lastUsed = latestChargerDate(s.chargers.map((ch) => ch.lastUsedOn));

  const station: StationViewMcp = {
    stationId: s.stationId,
    name: s.name,
    city: s.city,
    hours: s.hours,
    openText: s.openText,
    rating: s.rating ?? null,
    reviewCount: s.reviewCount ?? null,
    reliability: null,
    lastUsedOn: lastUsed,
    // AI-safe: usable plugs WITHOUT occupancy (free vs occupied is never told)
    ccs2Usable: summary.usable,
    ccs2Uncertain: summary.uncertain,
    ccs2Faulted: summary.faulted,
    ccs2Offline: summary.offline,
    maxKw: summary.maxKw,
    pricePerKwh: summary.pricePerKwh,
    fetchedAt: fetchedAt.toISOString(),
    synthetic: false,
  };

  const summaryText =
    `${station.name}${station.city ? ` (${station.city})` : ''}: ${station.ccs2Usable} usable CCS2 DC plug(s)` +
    (station.ccs2Uncertain > 0 ? `, ${station.ccs2Uncertain} status-uncertain` : '') +
    (station.ccs2Faulted > 0 ? `, ${station.ccs2Faulted} faulted` : '') +
    `, max ${station.maxKw ?? '?'} kW, tariff ${station.pricePerKwh != null ? `Rs. ${station.pricePerKwh}/kWh` : 'unknown'}` +
    `, rating ${station.rating ?? 'n/a'} (${station.reviewCount ?? 0} reviews)` +
    `, last used ${station.lastUsedOn ?? 'unknown'}` +
    `, reliability unavailable (no verified score in public data)` +
    `, fetched ${station.fetchedAt}.`;

  return { summary: summaryText, station };
}

/** Convert a live plan for structured MCP output (minimal refs only). */
export function planToStructured(plan: TripPlan): object {
  const saved = toSavedTrip(plan);
  return {
    ...saved,
    stops: plan.stops.map((s, i) => ({
      order: i + 1,
      stationId: s.station.stationId,
      name: s.station.name,
      brand: s.station.brand,
      chainageKm: s.chainageKm,
      arriveSocPct: s.arriveSocPct,
      leaveSocPct: s.leaveSocPct,
      chargeKwh: s.chargeKwh,
      estPriceInr: s.estPriceInr,
      chargeTimeMin: s.chargeTimeMin,
      tariffInrPerKwh: s.pricePerKwh,
      rating: s.station.rating,
      reviewCount: s.station.reviewCount,
      lastUsedOn: latestChargerDate(s.station.chargers?.map((c) => c.lastUsedOn) ?? []),
    })),
    warnings: plan.warnings,
  };
}

/** Recorded charger vocabulary is dd/mm/yyyy, not lexically sortable.
 * Invalid dates never outrank valid evidence; if all values are opaque,
 * preserve the first raw value rather than inventing a date or chronology. */
function latestChargerDate(values: Array<string | null>): string | null {
  const raw = values.filter((value): value is string => typeof value === 'string' && value.length > 0);
  let latest: { value: string; time: number } | undefined;
  for (const value of raw) {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
    if (!match) continue;
    const day = Number(match[1]);
    const month = Number(match[2]) - 1;
    const year = Number(match[3]);
    const date = new Date(0);
    date.setUTCFullYear(year, month, day);
    date.setUTCHours(0, 0, 0, 0);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) continue;
    if (!latest || date.getTime() > latest.time) latest = { value, time: date.getTime() };
  }
  return latest?.value ?? raw[0] ?? null;
}
