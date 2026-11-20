import { describe, expect, it } from 'vitest';
import type { SavedTrip } from '@indeev/core';
import { filterAndSortTrips } from '../src/trip-list.js';

function fixture(name: string, createdAt: string, origin: string, destination: string): SavedTrip {
  return {
    id: name, name, createdAt,
    origin: { label: origin, lat: 0, lon: 0 },
    destination: { label: destination, lat: 1, lon: 1 },
    vehicle: { label: 'EV', catalogId: null, batteryKwh: 75, claimedRangeKm: null, realWorldRangeKm: 300 },
    status: 'ok', source: 'live', routeDistanceKm: 120, routeDurationMin: 120,
    geometry: [], stations: [],
    totals: {
      distanceKm: 120, driveTimeMin: 110, totalTimeMin: 120, chargeTimeMin: 10,
      chargeKwh: 10, estPriceInr: null, finalSocPct: 20,
    },
  };
}

describe('saved trip local list', () => {
  it('matches name, origin and destination literally without changing the source list', () => {
    const trips = [
      fixture('Aurora', '2026-01-02T00:00:00Z', 'Delhi', 'Jaipur'),
      fixture('B <b>&amp;</b>', '2026-01-01T00:00:00Z', 'Pune', 'Goa'),
    ];
    const copy = [...trips];
    expect(filterAndSortTrips(trips, 'delhi', 'newest').map((entry) => entry.sourceIndex)).toEqual([0]);
    expect(filterAndSortTrips(trips, 'GOA', 'name').map((entry) => entry.sourceIndex)).toEqual([1]);
    expect(filterAndSortTrips(trips, '<b>&amp;</b>', 'name').map((entry) => entry.sourceIndex)).toEqual([1]);
    expect(filterAndSortTrips(trips, '  ', 'newest').map((entry) => entry.sourceIndex)).toEqual([0, 1]);
    expect(trips).toEqual(copy);
  });

  it('sorts newest, oldest and name with stable source indices', () => {
    const trips = [
      fixture('Charlie', '2026-01-02T00:00:00Z', 'A', 'B'),
      fixture('Alpha', '2026-01-03T00:00:00Z', 'C', 'D'),
      fixture('Bravo', '2026-01-01T00:00:00Z', 'E', 'F'),
    ];
    expect(filterAndSortTrips(trips, '', 'newest').map((entry) => entry.trip.name)).toEqual(['Alpha', 'Charlie', 'Bravo']);
    expect(filterAndSortTrips(trips, '', 'oldest').map((entry) => entry.sourceIndex)).toEqual([2, 0, 1]);
    expect(filterAndSortTrips(trips, '', 'name').map((entry) => entry.sourceIndex)).toEqual([1, 2, 0]);
  });

  it('cross-filters exact source and status while preserving original indices', () => {
    const liveOk = fixture('Live OK', '2026-01-04T00:00:00Z', 'Delhi', 'Goa');
    const liveDegraded = { ...fixture('Live degraded', '2026-01-03T00:00:00Z', 'Pune', 'Goa'), status: 'degraded' } as SavedTrip;
    const syntheticOk = { ...fixture('Synthetic OK', '2026-01-02T00:00:00Z', 'Chennai', 'Mumbai'), source: 'synthetic' } as SavedTrip;
    const syntheticDegraded = { ...fixture('Synthetic degraded', '2026-01-01T00:00:00Z', 'Agra', 'Mumbai'), source: 'synthetic', status: 'degraded' } as SavedTrip;
    const trips = [liveOk, liveDegraded, syntheticOk, syntheticDegraded];
    const before = JSON.stringify(trips);
    expect(filterAndSortTrips(trips, '', 'newest', { source: 'live', status: 'ok' }).map((e) => e.sourceIndex)).toEqual([0]);
    expect(filterAndSortTrips(trips, '', 'name', { source: 'synthetic', status: 'degraded' }).map((e) => e.sourceIndex)).toEqual([3]);
    expect(filterAndSortTrips(trips, 'goa', 'name', { source: 'live', status: 'degraded' }).map((e) => e.sourceIndex)).toEqual([1]);
    expect(filterAndSortTrips(trips, '', 'newest').map((e) => e.sourceIndex)).toEqual([0, 1, 2, 3]);
    expect(JSON.stringify(trips)).toBe(before);
  });

  it('classifies null, missing and malformed source/status as Unknown only', () => {
    const noSource = { ...fixture('No source', '2026-01-04T00:00:00Z', 'A', 'B'), source: null } as unknown as SavedTrip;
    const badStatus = { ...fixture('Bad status', '2026-01-03T00:00:00Z', 'C', 'D'), status: 'fresh' } as unknown as SavedTrip;
    const missing = { ...fixture('Missing', '2026-01-02T00:00:00Z', 'E', 'F'), source: undefined, status: undefined } as unknown as SavedTrip;
    const trips = [noSource, badStatus, missing];
    expect(filterAndSortTrips(trips, '', 'newest', { source: 'unknown' }).map((e) => e.sourceIndex)).toEqual([0, 2]);
    expect(filterAndSortTrips(trips, '', 'newest', { status: 'unknown' }).map((e) => e.sourceIndex)).toEqual([1, 2]);
    expect(filterAndSortTrips(trips, '', 'newest', { source: 'unknown', status: 'unknown' }).map((e) => e.sourceIndex)).toEqual([2]);
    expect(filterAndSortTrips(trips, '', 'newest', { source: 'live' }).map((e) => e.sourceIndex)).toEqual([]);
    expect(filterAndSortTrips(trips, '', 'newest', { status: 'ok' }).map((e) => e.sourceIndex)).toEqual([]);
  });

  it('places malformed dates last in either date direction and keeps ties in load order', () => {
    const trips = [
      fixture('No date', 'not-a-date', 'A', 'B'),
      fixture('Newer', '2026-02-01T00:00:00Z', 'C', 'D'),
      fixture('Tie newer', '2026-02-01T00:00:00Z', 'E', 'F'),
      fixture('Older', '2026-01-01T00:00:00Z', 'G', 'H'),
    ];
    expect(filterAndSortTrips(trips, '', 'newest').map((entry) => entry.trip.name))
      .toEqual(['Newer', 'Tie newer', 'Older', 'No date']);
    expect(filterAndSortTrips(trips, '', 'oldest').map((entry) => entry.trip.name))
      .toEqual(['Older', 'Newer', 'Tie newer', 'No date']);
  });
});
