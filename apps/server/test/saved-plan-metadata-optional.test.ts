import { describe, expect, it } from 'vitest';
import { validSavedPlanMetadata } from '../src/saved-plan-validation.js';

const basePlan = (overrides: Record<string, unknown> = {}) => ({
  createdAt: '2026-11-22T10:00:00.000Z', status: 'ok', source: 'live',
  routeDistanceKm: 285, routeDurationMin: 300,
  vehicle: { label: 'Test car', catalogId: null, batteryKwh: 60,
    claimedRangeKm: null, realWorldRangeKm: 400 },
  totals: { distanceKm: 285, driveTimeMin: 270, chargeTimeMin: 30,
    totalTimeMin: 300, chargeKwh: 30, estPriceInr: 600, finalSocPct: 20 },
  stops: [{ chainageKm: 100, legKm: 100, detourKm: 0, arriveSocPct: 30,
    leaveSocPct: 80, chargeKwh: 30, pricePerKwh: 20, estPriceInr: 600,
    chargeTimeMin: 30 }],
  ...overrides,
});

describe('optional saved plan start and ETA metadata', () => {
  it('accepts legacy records without start SOC or stop ETAs', () => {
    expect(validSavedPlanMetadata(basePlan())).toBe(true);
  });

  it('accepts a valid zero start and recorded non-negative ETAs', () => {
    expect(validSavedPlanMetadata(basePlan({ startSocPct: 0, stops: [{
      chainageKm: 100, legKm: 100, detourKm: 0, arriveSocPct: 30,
      leaveSocPct: 80, chargeKwh: 30, pricePerKwh: 20, estPriceInr: 600,
      chargeTimeMin: 30, arrivalEtaMin: 0, departureEtaMin: 30,
    }] }))).toBe(true);
  });

  it.each(['50', -1, 101, Number.NaN, null])('rejects invalid recorded start %j', (startSocPct) => {
    expect(validSavedPlanMetadata(basePlan({ startSocPct }))).toBe(false);
  });

  it.each(['30', -1, Number.NaN, null])('rejects invalid recorded ETA %j', (arrivalEtaMin) => {
    expect(validSavedPlanMetadata(basePlan({ stops: [{
      chainageKm: 100, legKm: 100, detourKm: 0, arriveSocPct: 30,
      leaveSocPct: 80, chargeKwh: 30, pricePerKwh: 20, estPriceInr: 600,
      chargeTimeMin: 30, arrivalEtaMin,
    }] }))).toBe(false);
  });
});
