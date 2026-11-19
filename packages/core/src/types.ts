/**
 * Wire shapes of the Statiq API replica plus core domain vocabulary.
 * Wire types mirror what the API actually returns (observed 2026-11);
 * they are intentionally loose where the API is inconsistent.
 */

// ---------- Statiq API wire shapes ----------

export interface StatiqMarker {
  stationId: number;
  name: string;
  lat: number;
  lon: number;
  address: string | null;
  accessType: number;
  isCommunityListed: boolean;
  stationUrl: string;
}

export interface StatiqMarkersResponse {
  ok: boolean;
  live: boolean;
  retained: boolean;
  source: string;
  count: number;
  stations: StatiqMarker[];
}

export interface StatiqCard {
  stationId: number;
  name: string;
  lat: number;
  lon: number;
  address: string | null;
  area: string | null;
  rating: number;
  types: number[];
  accessType: number;
  isCommunityListed: boolean;
  navUrl: string;
  stationUrl: string;
}

export interface StatiqCardsResponse {
  ok: boolean;
  live: boolean;
  retained: boolean;
  source: string;
  count: number;
  cards: StatiqCard[];
}

export interface StatiqConnector {
  displayId: number;
  connectorId: number;
  type: string; // 'CCS-2' | 'Type-2' | 'GBT' | 'Wall' | ...
  status: string; // 'available' | 'charging' | 'faulted' | 'preparing' | 'finishing' | 'unavailable' | ...
  available: boolean | null;
  note: string | null; // 'Charging' | 'Faulted' | 'Disconnected' | 'Finished' | ...
}

export interface StatiqCharger {
  chargerId: number;
  name: string;
  type: 'DC' | 'AC' | string;
  kw: number;
  pricePerKwh: number | null;
  currency: string | null;
  lastUsedOn: string | null; // dd/mm/yyyy
  connectors: StatiqConnector[];
}

export interface StatiqStationDetail {
  stationId: number;
  name: string;
  lat: number;
  lon: number;
  address: string | null;
  area: string | null;
  city: string | null;
  landmark: string | null;
  hours: string | null;
  openText: string | null;
  rating: number | null;
  reviewCount: number | null;
  accessType: string | null;
  navUrl: string;
  stationUrl: string;
  imageUrl: string | null;
  amenities: string[];
  stepsToReach: string | null;
  chargers: StatiqCharger[];
  summary: {
    anyDc: boolean;
    ccs2Dc: boolean;
    maxDcCcs2Kw: number | null;
    availableNow: boolean;
    statusCounts: Record<string, number>;
  } | null;
}

export interface StatiqDetailsResponse {
  ok: boolean;
  live: boolean;
  retained: boolean;
  source: string;
  station: StatiqStationDetail | null;
}

// ---------- Domain vocabulary ----------

/** Charger brands we prefer, best first. Derived from station/charger names. */
export type Brand = 'statiq' | 'tata' | 'bpcl' | 'hp' | 'other';

/** Preference rank for brands (lower is better). */
export const BRAND_RANK: Record<Brand, number> = {
  statiq: 0,
  tata: 1,
  bpcl: 2,
  hp: 3,
  other: 4,
};

export const BRAND_LABEL: Record<Brand, string> = {
  statiq: 'Statiq',
  tata: 'Tata',
  bpcl: 'BPCL',
  hp: 'HP',
  other: 'Other',
};

/**
 * Health of a single CCS2 DC plug, combining status + fault text.
 *
 * - working-free: functional and idle right now
 * - working-occupied: functional but in use (kept as an option; the AI is
 *   never told occupancy, per spec, since by arrival time it may change)
 * - finishing: functional, session wrapping up
 * - faulted: explicitly faulted (status and/or fault text agree) -> excluded
 * - uncertain: status and fault text contradict each other -> never shown
 *   as "working"; the UI shows uncertainty instead of guessing
 * - offline: disconnected/unavailable without fault text
 */
export type PlugHealth =
  | 'working-free'
  | 'working-occupied'
  | 'finishing'
  | 'faulted'
  | 'uncertain'
  | 'offline';

/** Health of a station as a charging-stop candidate, combining all its CCS2 DC plugs. */
export type StationPlugSummary = {
  bestHealth: PlugHealth;
  usable: boolean;
  maxKw: number | null;
  plugs: { total: number; usable: number };
};
