/**
 * Saved-trip shape and the pure plan -> saved-trip reduction. No Node APIs:
 * the server file store and the hosted web build's on-device store share
 * this exact conversion, so both keep the same minimal form.
 */
import type { TripPlan } from './plan-types.js';

/** Minimal station reference kept in a saved trip. */
export interface SavedStationRef {
  stationId: number;
  name: string;
  lat: number;
  lon: number;
  chainageKm: number;
  legKm: number;
  detourKm: number;
  arriveSocPct: number;
  leaveSocPct: number;
  chargeKwh: number;
  pricePerKwh: number | null;
  estPriceInr: number | null;
  chargeTimeMin: number;
  /** Plan-derived minutes from trip start; absent in older saved records. */
  arrivalEtaMin?: number;
  departureEtaMin?: number;
}

export interface SavedTrip {
  id: string;
  name: string;
  createdAt: string;
  origin: { label: string; lat: number; lon: number };
  destination: { label: string; lat: number; lon: number };
  /** Ordered user stopovers; copied only when non-empty. */
  via?: TripPlan['via'];
  vehicle: TripPlan['vehicle'];
  /** Validated starting charge from the originating plan, when available. */
  startSocPct?: number;
  /** Scan integrity at planning time (degraded plans show visible holes). */
  status: TripPlan['status'];
  /** Provenance: live vs synthetic; synthetic trips never enter the live store. */
  source: TripPlan['source'];
  routeDistanceKm: number;
  routeDurationMin: number;
  /** Route geometry: [lat, lon] pairs, kept so the map can redraw the path. */
  geometry: [number, number][];
  stations: SavedStationRef[];
  totals: TripPlan['totals'];
}

function savedSoc(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value : undefined;
}
function savedEta(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Reduce a live plan to the minimal saved form (no station detail data). */
export function toSavedTrip(plan: TripPlan, name?: string): SavedTrip {
  const startSocPct = savedSoc(plan.startSocPct);
  return {
    id: plan.id || globalThis.crypto.randomUUID(),
    name: name?.trim() || tripName(plan),
    createdAt: plan.createdAt,
    origin: plan.origin,
    destination: plan.destination,
    ...(plan.via?.length ? { via: plan.via.map(place => ({ label: place.label, lat: place.lat, lon: place.lon })) } : {}),
    vehicle: plan.vehicle,
    ...(startSocPct !== undefined ? { startSocPct } : {}),
    status: plan.status,
    source: plan.source,
    routeDistanceKm: plan.routeDistanceKm,
    routeDurationMin: plan.routeDurationMin,
    geometry: plan.geometry.map((p) => [p.lat, p.lon] as [number, number]),
    stations: plan.stops.map((s) => {
      const arrivalEtaMin = savedEta(s.arrivalEtaMin);
      const departureEtaMin = savedEta(s.departureEtaMin);
      return {
        stationId: s.station.stationId,
        name: s.station.name,
        lat: s.station.lat,
        lon: s.station.lon,
        chainageKm: s.chainageKm,
        legKm: s.legKm,
        detourKm: s.detourKm,
        arriveSocPct: s.arriveSocPct,
        leaveSocPct: s.leaveSocPct,
        chargeKwh: s.chargeKwh,
        pricePerKwh: s.pricePerKwh,
        estPriceInr: s.estPriceInr,
        chargeTimeMin: s.chargeTimeMin,
        ...(arrivalEtaMin !== undefined ? { arrivalEtaMin } : {}),
        ...(departureEtaMin !== undefined ? { departureEtaMin } : {}),
      };
    }),
    totals: plan.totals,
  };
}

function tripName(plan: TripPlan): string {
  const date = new Date(plan.createdAt);
  return `${plan.origin.label} → ${plan.destination.label} (${date.toLocaleDateString('en-IN')})`;
}
