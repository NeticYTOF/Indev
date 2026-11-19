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
  amenities: string[];
  stationUrl: string;
  navUrl: string;
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

export interface TripPlan {
  id: string;
  createdAt: string;
  origin: PlaceRef;
  destination: PlaceRef;
  routeDistanceKm: number;
  routeDurationMin: number;
  geometry: Coords[];
  stops: PlanStop[];
  totals: PlanTotals;
  /** Unique stations examined live during this planning run. */
  stationsSeen: number;
  warnings: string[];
}

export interface PlanOptions {
  startSocPct?: number;
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
  minArrivalSocPct: 10,
  maxSocPerStopPct: 80,
  absoluteMaxSocPct: 95,
  maxLegKm: 300,
  preferredLegMinKm: 250,
  preferredLegMaxKm: 300,
  primaryDetourKm: 2,
  fallbackDetourKm: 5,
  brandClusterKm: 15,
  avgSpeedKmh: 62,
};
