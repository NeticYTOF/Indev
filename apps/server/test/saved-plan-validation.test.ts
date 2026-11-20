import { describe, expect, it } from 'vitest';
import { validSavedPlanMetadata } from '../src/saved-plan-validation.js';

function valid() {
  return {
    createdAt: '2026-11-20T00:00:00Z', status: 'ok', routeDistanceKm: 100, routeDurationMin: 60,
    vehicle: { label: 'Fixture', catalogId: null, batteryKwh: 75, claimedRangeKm: null, realWorldRangeKm: null },
    totals: { distanceKm: 100, driveTimeMin: 60, chargeTimeMin: 0, totalTimeMin: 60, chargeKwh: 0, estPriceInr: null, finalSocPct: 0 },
    stops: [],
  };
}
describe('new saved-plan metadata validation', () => {
  it('allows unknown optional prices/ranges and zero totals without mutation', () => {
    const value = valid(); const before = JSON.stringify(value);
    expect(validSavedPlanMetadata(value)).toBe(true); expect(JSON.stringify(value)).toBe(before);
  });
  it('rejects nonfinite values that cannot be represented as persisted numbers', () => {
    for (const number of [NaN, Infinity, -Infinity]) {
      const value = valid(); value.routeDistanceKm = number;
      expect(validSavedPlanMetadata(value)).toBe(false);
    }
  });
  it.each([null, [], { vehicle: true, totals: true, stops: [] }])('refuses malformed containers: %j', input => {
    expect(validSavedPlanMetadata(input)).toBe(false);
  });
});
