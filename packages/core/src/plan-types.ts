/**
 * Trip plan domain types. A live TripPlan carries full station views for
 * display; when SAVED, plans are reduced to minimal station references plus
 * route geometry (see trips.ts).
 */
import type { Coords } from './geo.js';
import type { Brand, PlugHealth } from './types.js';

export interface PlaceRef {
  label: string;
  lat: number;
  lon: number;
}

export interface PlugView {
  connectorId: number;
  type: string;
  health: PlugHealth;
  contradiction: boolean;
}

export interface ChargerView {
  chargerId: number;
  name: string;
  type: string;
  kw: number;
  pricePerKwh: number | null;
  lastUsedOn: string | null;
  plugs: PlugView[];
}

/** What the UI renders for a charging stop. Reliability is null by design. */
export interface StationLiveView {
  stationId: number;
  name: string;
  brand: Brand;
  lat: number;
  lon: number;
  address: string | null;
  city: string | null;
  hours: string | null;
  openText: string | null;
  rating: number | null;
  reviewCount: number | null;
  /** Public data has no verified reliability score: always null, never 0. */
  reliability: null;
  /** When this station's live data was actually fetched (memo honesty). */
  fetchedAt: string;
  /** True only on synthetic (mock) stations; the UI labels them. */
  synthetic?: true;
  amenities: string[];
  /** Upstream station page; null on synthetic stations (never fabricated). */
  stationUrl: string | null;
  /** Upstream-provided nav shortcut; null on synthetic stations. */
  navUrl: string | null;
  chargers: ChargerView[];
}

export interface PlanStop {
  station: StationLiveView;
  /** km from trip start along the route. */
  chainageKm: number;
  /** km driven on this leg (route chainage delta + detour both ways). */
  legKm: number;
  /** one-way detour off the route, km. */
  detourKm: number;
  arriveSocPct: number;
  leaveSocPct: number;
  chargeKwh: number;
  pricePerKwh: number | null;
  estPriceInr: number | null;
  chargeTimeMin: number;
  /** minutes from trip start when the car arrives at this stop. */
  arrivalEtaMin: number;
  departureEtaMin: number;
}

export interface PlanTotals {
  distanceKm: number;
  driveTimeMin: number;
  chargeTimeMin: number;
  /** driving + charging, excluding detour time overhead of detours already in legs */
  totalTimeMin: number;
  chargeKwh: number;
  estPriceInr: number | null;
  finalSocPct: number;
}

/** Which vehicle the plan was computed for (claim vs user input kept separate). */
export interface PlanVehicleMeta {
  label: string;
  catalogId: string | null;
  batteryKwh: number;
  /** Manufacturer-claimed range (MIDC/ARAI), display-only. */
  claimedRangeKm: number | null;
  /** User-provided real-world/safe range, km. Null = Harrier default assumption. */
  realWorldRangeKm: number | null;
}

/** Scan integrity of the plan: degraded plans carry visible holes. */
export type PlanStatus = 'ok' | 'degraded';

/** Where a plan came from: live upstream, or synthetic mock data. */
export type PlanSource = 'live' | 'synthetic';

/**
 * AI-safe candidate summary (planner includeCandidates option).
 * Deliberately carries NO plug-occupancy information: usable CCS2 plugs
 * are offered to the AI without telling it which are occupied.
 */
export interface PlanCandidate {
  stationId: number;
  name: string;
  brand: Brand;
  chainageKm: number;
  offRouteKm: number;
  city: string | null;
  rating: number | null;
  reviewCount: number | null;
  maxKw: number | null;
  pricePerKwh: number | null;
}

export interface TripPlan {
  id: string;
  createdAt: string;
  origin: PlaceRef;
  destination: PlaceRef;
  vehicle: PlanVehicleMeta;
  status: PlanStatus;
  /** Provenance: live plans only may enter the real saved-trips store. */
  source: PlanSource;
  routeDistanceKm: number;
  routeDurationMin: number;
  geometry: Coords[];
  stops: PlanStop[];
  totals: PlanTotals;
  /** Unique stations examined live during this planning run. */
  stationsSeen: number;
  warnings: string[];
  /** Present when planned with includeCandidates (AI-safe, no occupancy). */
  candidates?: PlanCandidate[];
}

export interface PlanRunBudget {
  /** Overall wall-clock budget for the entire planning run, ms. */
  deadlineMs: number;
  /** Hard cap on upstream (Statiq) calls in this run (marker + details). */
  maxUpstreamCalls: number;
}

export interface PlanOptions {
  startSocPct?: number;
  /** Bounded-run controls: deadline + request budget with cancellation. */
  runBudget?: PlanRunBudget;
  /** Attach AI-safe candidates (no occupancy) to the plan. */
  includeCandidates?: boolean;
  /** Minimum SoC the plan promises on arrival anywhere. */
  minArrivalSocPct?: number;
  /** SoC ceiling per stop (past this the DC curve tapers hard). */
  maxSocPerStopPct?: number;
  /** Absolute max SoC ever charged to, for tight situations. */
  absoluteMaxSocPct?: number;
  /** Hard cap on the gap between charging stops, km. */
  maxLegKm?: number;
  /** Preferred leg window, km. */
  preferredLegMinKm?: number;
  preferredLegMaxKm?: number;
  /** Stations this close to the route are first-choice. */
  primaryDetourKm?: number;
  /** Stations further than primary but within this are fallback-only. */
  fallbackDetourKm?: number;
  /** Cluster tolerance for brand tie-breaking, km. */
  brandClusterKm?: number;
  /** Average driving speed for ETA math, km/h. */
  avgSpeedKmh?: number;
}

export const DEFAULT_PLAN_OPTIONS: Required<PlanOptions> = {
  startSocPct: 100,
  minArrivalSocPct: 10, // working estimate
  maxSocPerStopPct: 80, // working estimate (DC taper knee)
  absoluteMaxSocPct: 95, // working estimate
  maxLegKm: 300, // OWNER-SUPPLIED: 300 km safe running range
  preferredLegMinKm: 250, // owner preference: legs of 250-300 km
  preferredLegMaxKm: 300, // owner preference: legs of 250-300 km
  primaryDetourKm: 2,
  fallbackDetourKm: 5,
  brandClusterKm: 15,
  avgSpeedKmh: 62,
  runBudget: {
    deadlineMs: 5 * 60_000,
    maxUpstreamCalls: 220,
  },
  includeCandidates: false,
};
/*
 * Only battery size (75 kWh) and the 300 km safe running range are
 * owner-supplied. Every other default above is a working estimate and may
 * be tuned per request.
 */
