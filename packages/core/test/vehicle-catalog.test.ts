import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HARRIER_ENTRY_ID,
  VEHICLE_CATALOG,
  VehicleSelectionError,
  resolveVehicle,
} from '../src/vehicle-catalog.js';
import { HARIER_EV_75, MODEL_WORKING_ESTIMATES } from '../src/vehicle.js';

describe('vehicle catalog', () => {
  it('has a starter catalog with published claims only', () => {
    expect(VEHICLE_CATALOG.length).toBeGreaterThanOrEqual(10);
    for (const e of VEHICLE_CATALOG) {
      expect(e.batteryKwh).toBeGreaterThan(5);
      expect(e.claimedRangeKm).toBeGreaterThan(100);
      expect(e.id).toMatch(/^[a-z0-9-]+$/);
    }
    expect(VEHICLE_CATALOG.find((e) => e.id === DEFAULT_HARRIER_ENTRY_ID)).toBeDefined();
  });
});

describe('resolveVehicle', () => {
  it('defaults to the unchanged Harrier EV 75 kWh profile', () => {
    const r = resolveVehicle();
    expect(r.config).toEqual(HARIER_EV_75); // exactly the existing working-estimates profile
    expect(r.claimedRangeKm).toBe(627);
    expect(r.realWorldRangeKm).toBeNull(); // user input not invented
  });

  it('never invents real-world range for non-default catalog vehicles', () => {
    expect(() => resolveVehicle({ entryId: 'tata-nexon-ev-lr-45' })).toThrow(VehicleSelectionError);
    try {
      resolveVehicle({ entryId: 'tata-nexon-ev-lr-45' });
    } catch (e) {
      expect((e as Error).message).toContain('real-world range');
      // the claim is referenced but never merged into the model
      expect((e as Error).message).toContain('465');
    }
  });

  it('derives consumption from user-provided real-world range', () => {
    const r = resolveVehicle({ entryId: 'tata-nexon-ev-lr-45', realWorldRangeKm: 300 });
    expect(r.realWorldRangeKm).toBe(300);
    expect(r.claimedRangeKm).toBe(465); // claim preserved separately, never merged
    // usable = 45 * 0.95 = 42.75 kWh over 300 km -> 142.5 Wh/km
    expect(r.config.whPerKm).toBeCloseTo(142.5, 1);
    expect(r.config.batteryKwh).toBe(45);
    expect(r.config.usableFraction).toBe(MODEL_WORKING_ESTIMATES.usableFraction);
  });

  it('accepts real-world range for the Harrier too', () => {
    const r = resolveVehicle({
      entryId: DEFAULT_HARRIER_ENTRY_ID,
      realWorldRangeKm: 400,
    });
    // usable 71.25 / 400 km = 178.125 Wh/km
    expect(r.config.whPerKm).toBeCloseTo(178.125, 2);
    expect(r.realWorldRangeKm).toBe(400);
    expect(r.claimedRangeKm).toBe(627);
  });

  it('supports fully custom vehicles with required real-world range', () => {
    const r = resolveVehicle({
      custom: { label: 'My EV', batteryKwh: 60, claimedRangeKm: 500, realWorldRangeKm: 350 },
    });
    expect(r.catalogId).toBeNull();
    expect(r.label).toBe('My EV');
    expect(r.claimedRangeKm).toBe(500);
    expect(r.realWorldRangeKm).toBe(350);
    // usable 57 / 350 = 162.857 Wh/km
    expect(r.config.whPerKm).toBeCloseTo(162.857, 2);
    expect(() =>
      resolveVehicle({ custom: { batteryKwh: 60, realWorldRangeKm: undefined as never } }),
    ).toThrow(VehicleSelectionError);
  });

  it('rejects unknown catalog ids and implausible inputs', () => {
    expect(() => resolveVehicle({ entryId: 'tesla-model-3' })).toThrow(VehicleSelectionError);
    expect(() =>
      resolveVehicle({ entryId: 'tata-nexon-ev-lr-45', realWorldRangeKm: 5 }),
    ).toThrow(VehicleSelectionError);
    expect(() =>
      resolveVehicle({ entryId: 'tata-nexon-ev-lr-45', realWorldRangeKm: 5000 }),
    ).toThrow(VehicleSelectionError);
  });
});
