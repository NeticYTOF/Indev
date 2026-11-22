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
  /** Planning-only state; policy exclusions may be faulted while observed health is uncertain. */
  planningHealth: PlugHealth;
  /** Host planning policy marker; not a hardware-health claim. */
  policyExclusion?: 'positive_fault_with_available_status';
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
  accessType?: string | null;
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

export interface PlanSelectedCharger {
  chargerId: number;
  name: string;
  kw: number;
  pricePerKwh: number | null;
  lastUsedOn?: string | null;
}

export interface PlanCandidateCharger {
  chargerId: number;
  name: string;
  type: string;
  kw: number | null;
  pricePerKwh: number | null;
  lastUsedOn: string | null;
}

export interface PlanCandidateEvidence {
  fetchedAt: string;
  hours: string | null;
  openText: string | null;
  address: string | null;
  accessType: string | null;
  stationUrl: string | null;
  navUrl: string | null;
  amenities: readonly string[];
  reliability: null;
  reliabilityNote: 'No verified reliability score is available.';
  ccs2EligibleCount: number;
  ccs2ContradictionCount: number;
  chargers: readonly PlanCandidateCharger[];
}

export interface PlanStop {
  station: StationLiveView;
  /** Actual capped charger used for this stop's time and tariff. */
  selectedCharger?: PlanSelectedCharger;
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
  selectedCharger?: PlanSelectedCharger;
  evidence: PlanCandidateEvidence;
}

export interface TripPlan {
  id: string;
  createdAt: string;
  origin: PlaceRef;
  destination: PlaceRef;
  /** Ordered user stopovers; they do not reset battery or charging continuity. */
  via?: PlaceRef[];
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

/**
 * Structured, terminal coverage evidence attached to `not_determined`
 * planning errors. Advisory only: these numbers report what THIS bounded
 * run observed, never a route verdict. `candidateInventoryComplete` is the
 * only claim about the discovered pool, and stays false until the corridor
 * scan CALL returns - a 0 candidate count during the scan is unknown, not
 * an empty inventory.
 */
export interface RunCoverageSnapshot {
  /** Marker sample points planned by the corridor scan (plan-first). */
  samplesPlanned: number;
  /** Samples with a response received (ok or failed); never a dispatch count. */
  samplesCompleted: number;
  samplesOk: number;
  samplesFailed: number;
  /** Unique candidate pool of a COMPLETED scan; 0/unknown while in flight. */
  candidatesPlanned: number;
  /** Candidate lookups COMPLETED (fetched, empty or failed). */
  candidatesProcessed: number;
  candidatesDetailed: number;
  /** True only once scanCorridor resolved; false during an in-flight/aborted scan. */
  candidateInventoryComplete: boolean;
  /** Observed upstream attempts (unresolved bulk holds excluded). */
  observedAttempts: number;
  maxAttempts: number;
  /** Reserved but unconfirmed bulk attempts, held fail-closed. */
  unconfirmedReservations: number;
  /**
   * Advisory remaining calls (>= 0). While candidateInventoryComplete is
   * false this is only the MINIMUM known remaining samples: undiscovered
   * candidates are excluded, so it is NOT the full-coverage total.
   */
  remainingCalls: number;
  /** Advisory sustained-pacing wall estimate (ms); meaningful only with a
   *  known inventory, and never a strict bound. */
  remainingEstimateMs: number;
  /** Assumed per-call pace used for that estimate, ms. */
  pacePerCallMs: number;
}
export interface PlanOptions {
  /** Original parity: arrival reserve; maps to minArrivalSocPct when supplied. */
  reservePct?: number;
  /** Original parity: explicit charge-to departure SoC at every charging stop. */
  targetSoc?: number;
  startSocPct?: number;
  /** Ordered user stopovers; validated/copied at plan start. */
  via?: readonly PlaceRef[];
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
  /** Hard ceiling for a selected charger's rated kW; absent preserves old behavior. */
  maxChargerKw?: number;
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

export type ResolvedPlanOptions =
  Required<Omit<PlanOptions, 'targetSoc' | 'reservePct'>> &
  Pick<PlanOptions, 'targetSoc' | 'reservePct'>;
export const DEFAULT_PLAN_OPTIONS: ResolvedPlanOptions = {
  startSocPct: 100,
  via: [],
  minArrivalSocPct: 10, // working estimate
  maxSocPerStopPct: 80, // working estimate (DC taper knee)
  absoluteMaxSocPct: 95, // working estimate
  maxLegKm: 300, // OWNER-SUPPLIED: 300 km safe running range
  maxChargerKw: Number.POSITIVE_INFINITY,
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
