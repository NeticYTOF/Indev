/**
 * Pure saved-trip → planner-composer adapter.
 *
 * Saved routes are copied into the existing composer for user review only.
 * This module never fetches coordinates, vehicles, plans, stations or AI
 * output, never mutates the saved trip, and never treats unsaved settings as
 * recovered facts. Corrupt optional metadata becomes an explicit review item.
 */
import type { SavedTrip } from '@indeev/core';

export interface SavedRoutePlaceDraft {
  label: string;
  lat: number;
  lon: number;
}

export interface SavedRouteVehicleDraft {
  /** Stored catalog identity, retained literally for the selector mapper. */
  catalogId: string | null;
  label: string;
  batteryKwh: number | null;
  claimedRangeKm: number | null;
  /** The user's saved real-world input, never a claim-derived substitute. */
  realWorldRangeKm: number | null;
}

export interface SavedRouteDraft {
  origin: SavedRoutePlaceDraft;
  destination: SavedRoutePlaceDraft;
  vehicle: SavedRouteVehicleDraft;
  /** Facts missing or malformed in storage; the user must review these. */
  reviewNotes: string[];
  /** Optional explicit heading for a distinct manual workflow. */
  reviewTitle?: string;
}

export const RETURN_ROUTE_REVIEW_NOTE =
  'New return-direction plan: only the saved origin and destination were swapped. ' +
  'Saved stops, geometry, totals and any previous results were not reversed or reused. ' +
  'Review every option and start a new plan manually.';

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positiveInRange(value: unknown, min: number, max: number): number | null {
  const number = finite(value);
  return number != null && number >= min && number <= max ? number : null;
}

function place(
  value: SavedTrip['origin'] | undefined,
  label: string,
  reviewNotes: string[],
): SavedRoutePlaceDraft {
  const lat = finite(value?.lat);
  const lon = finite(value?.lon);
  if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    reviewNotes.push(`${label} coordinates were not stored validly; reselect the place before planning.`);
  }
  return {
    label: typeof value?.label === 'string' ? value.label : '',
    lat: lat ?? Number.NaN,
    lon: lon ?? Number.NaN,
  };
}

/**
 * Copy the saved facts into plain composer values. The draft preserves an
 * unusable coordinate as NaN only so callers can detect it without inventing
 * a replacement; the planner controller refuses to load such a draft.
 */
export function buildSavedRouteDraft(trip: SavedTrip): SavedRouteDraft {
  if (!trip || typeof trip !== 'object') {
    return {
      origin: { label: '', lat: Number.NaN, lon: Number.NaN },
      destination: { label: '', lat: Number.NaN, lon: Number.NaN },
      vehicle: { catalogId: null, label: '', batteryKwh: null, claimedRangeKm: null, realWorldRangeKm: null },
      reviewNotes: ['Saved trip data was missing or malformed; review every copied fact.'],
    };
  }
  const reviewNotes: string[] = [
    'Start charge, charging reserve and other plan options were not stored with this trip — review them before planning.',
  ];
  const vehicle = trip.vehicle as SavedTrip['vehicle'] | undefined;
  const catalogId = vehicle?.catalogId === null || typeof vehicle?.catalogId === 'string'
    ? vehicle.catalogId
    : null;
  const batteryKwh = positiveInRange(vehicle?.batteryKwh, 5, 250);
  const claimedRangeKm = positiveInRange(vehicle?.claimedRangeKm, 1, 2000);
  const realWorldRangeKm = positiveInRange(vehicle?.realWorldRangeKm, 20, 1500);

  if (batteryKwh == null) reviewNotes.push('Saved battery size was missing or outside the supported range.');
  if (realWorldRangeKm == null) {
    reviewNotes.push('Saved real-world range was missing or outside the supported range; enter your own value.');
  }
  if (catalogId == null) {
    reviewNotes.push('Saved catalog identity is unavailable; the known battery and range values will use the custom vehicle inputs.');
  }

  return {
    origin: place(trip.origin, 'Saved origin', reviewNotes),
    destination: place(trip.destination, 'Saved destination', reviewNotes),
    vehicle: {
      catalogId,
      label: typeof vehicle?.label === 'string' ? vehicle.label : '',
      batteryKwh,
      claimedRangeKm,
      realWorldRangeKm,
    },
    reviewNotes,
  };
}

/**
 * Build a NEW forward-draft in the opposite direction. This copies only the
 * validated composer facts; it never derives reverse stops, distance, time or
 * saved results, and never touches the source record.
 */
export function buildReturnRouteDraft(trip: SavedTrip): SavedRouteDraft {
  const forward = buildSavedRouteDraft(trip);
  return {
    origin: { ...forward.destination },
    destination: { ...forward.origin },
    vehicle: { ...forward.vehicle },
    reviewNotes: [RETURN_ROUTE_REVIEW_NOTE, ...forward.reviewNotes],
    reviewTitle: 'New return-direction plan — review before planning',
  };
}

export function savedRouteDraftReady(draft: SavedRouteDraft): boolean {
  return [draft.origin, draft.destination].every((placeDraft) =>
    placeDraft.label.length > 0 &&
    Number.isFinite(placeDraft.lat) &&
    Number.isFinite(placeDraft.lon) &&
    Math.abs(placeDraft.lat) <= 90 &&
    Math.abs(placeDraft.lon) <= 180,
  );
}
