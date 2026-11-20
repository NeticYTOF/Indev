import { describe, expect, it } from 'vitest';
import type { SavedTrip } from '@indeev/core';
import { buildSavedRouteDraft, savedRouteDraftReady } from '../src/saved-route.js';

function savedTrip(overrides: Partial<SavedTrip> = {}): SavedTrip {
  return {
    id: 'saved-route', name: 'Saved route', createdAt: '2026-11-19T18:00:00Z',
    origin: { label: 'Delhi', lat: 28.6139, lon: 77.209 },
    destination: { label: 'Jaipur', lat: 26.9124, lon: 75.7873 },
    vehicle: {
      label: 'Tata Harrier EV (75 kWh)', catalogId: 'tata-harrier-ev-75',
      batteryKwh: 75, claimedRangeKm: 627, realWorldRangeKm: 300,
    },
    status: 'ok', source: 'live', routeDistanceKm: 285, routeDurationMin: 270,
    geometry: [[28.6139, 77.209], [26.9124, 75.7873]],
    stations: [],
    totals: {
      distanceKm: 285, driveTimeMin: 270, chargeTimeMin: 0, totalTimeMin: 270,
      chargeKwh: 0, estPriceInr: null, finalSocPct: 40,
    },
    ...overrides,
  };
}

describe('saved route composer adapter', () => {
  it('copies exact saved coordinates and known vehicle facts without inventing options', () => {
    const source = savedTrip();
    const draft = buildSavedRouteDraft(source);

    expect(draft.origin).toEqual(source.origin);
    expect(draft.destination).toEqual(source.destination);
    expect(draft.vehicle).toEqual({
      catalogId: 'tata-harrier-ev-75',
      label: 'Tata Harrier EV (75 kWh)',
      batteryKwh: 75,
      claimedRangeKm: 627,
      realWorldRangeKm: 300,
    });
    expect(savedRouteDraftReady(draft)).toBe(true);
    expect(draft.reviewNotes.join(' ')).toContain('Start charge, charging reserve and other plan options were not stored');
    expect(source.origin.lat).toBe(28.6139);
  });

  it('reports legacy metadata as review items instead of replacing it with claims', () => {
    const source = savedTrip({ vehicle: {
      label: 'Legacy vehicle', catalogId: null, batteryKwh: 62,
      claimedRangeKm: 500, realWorldRangeKm: null,
    } });
    const draft = buildSavedRouteDraft(source);

    expect(draft.vehicle.catalogId).toBeNull();
    expect(draft.vehicle.batteryKwh).toBe(62);
    expect(draft.vehicle.realWorldRangeKm).toBeNull();
    expect(draft.vehicle.claimedRangeKm).toBe(500);
    expect(draft.reviewNotes.join(' ')).toContain('custom vehicle inputs');
    expect(draft.reviewNotes.join(' ')).toContain('enter your own value');
  });

  it('refuses to load invalid saved coordinates', () => {
    const draft = buildSavedRouteDraft(savedTrip({
      origin: { label: 'Broken', lat: Number.NaN, lon: 77 },
    }));
    expect(savedRouteDraftReady(draft)).toBe(false);
    expect(draft.reviewNotes.join(' ')).toContain('Saved origin coordinates were not stored validly');
  });
});
