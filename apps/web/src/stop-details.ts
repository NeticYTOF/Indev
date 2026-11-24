/**
 * Glue between the map, the stop cards and the stop sheet for one drawn
 * trip. Fresh plans and saved trips share this so the two views behave the
 * same: tap a marker or a card's "Charger details" to open the sheet.
 */
import type * as maplibregl from 'maplibre-gl';
import { tripLegs } from './leg-distance.js';
import { revealStop, setActiveStop, type DrawTripOptions } from './map.js';
import { closeStopSheet, openStopSheet, type StopSheetContext, type StopSheetSource } from './stop-sheet.js';

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export interface StopDetailsTrip {
  source: StopSheetSource;
  stops: readonly unknown[];
  originLabel: unknown;
  destinationLabel: unknown;
  totalDistanceKm: unknown;
  /** Container holding the stop cards for this trip. */
  cards: () => ParentNode | null;
  /** Card selector inside the container. */
  cardSelector: string;
}

function coordinate(stop: unknown, source: StopSheetSource): [number, number] | null {
  const s = record(stop);
  const station = source === 'plan' ? record(s?.station) : s;
  const lat = station?.lat;
  const lon = station?.lon;
  return typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lon, lat] : null;
}

export function stopDetailsContext(map: maplibregl.Map, trip: StopDetailsTrip): StopSheetContext {
  return {
    source: trip.source,
    stops: trip.stops,
    originLabel: trip.originLabel,
    destinationLabel: trip.destinationLabel,
    totalDistanceKm: trip.totalDistanceKm,
    onActive: (index) => setActiveStop(map, index),
    onReveal: (index) => {
      const at = coordinate(trip.stops[index], trip.source);
      if (at) revealStop(map, at);
    },
    cardFor: (index) => {
      const cards = trip.cards()?.querySelectorAll<HTMLElement>(trip.cardSelector);
      return cards?.[index] ?? null;
    },
  };
}

/** Map options for drawTrip: clickable stops + leg distance pills. */
export function stopDetailsMapOptions(map: maplibregl.Map, trip: StopDetailsTrip): DrawTripOptions {
  const legs = tripLegs({
    originLabel: trip.originLabel, destinationLabel: trip.destinationLabel,
    stops: trip.stops, totalDistanceKm: trip.totalDistanceKm,
  });
  const total = typeof trip.totalDistanceKm === 'number' && Number.isFinite(trip.totalDistanceKm) && trip.totalDistanceKm > 0
    ? trip.totalDistanceKm : null;
  return {
    onStopClick: (index) => {
      const marker = document.querySelector<HTMLElement>(`.stop-marker[data-stop-index="${index}"]`);
      openStopSheet(stopDetailsContext(map, trip), index, marker);
    },
    legs,
    totalKm: total,
  };
}

/** Wire every "Charger details" button inside the trip's cards. */
export function wireStopDetailButtons(map: maplibregl.Map, trip: StopDetailsTrip, buttonSelector: string): void {
  const root = trip.cards();
  if (!root) return;
  root.querySelectorAll<HTMLButtonElement>(buttonSelector).forEach((button, index) => {
    button.addEventListener('click', () => openStopSheet(stopDetailsContext(map, trip), index, button));
  });
}

export { closeStopSheet };
