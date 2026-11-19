import { describe, expect, it } from 'vitest';
import {
  HARIER_EV_75,
  chargeTimeMin,
  kwhForDistance,
  kwhForSocDelta,
  socAfterDriving,
  usableKwh,
} from '../src/vehicle.js';

describe('vehicle model (Harrier EV 75 kWh)', () => {
  it('usable energy is 95% of the pack', () => {
    expect(usableKwh(HARIER_EV_75)).toBeCloseTo(71.25, 2);
  });

  it('consumption grows linearly with distance', () => {
    expect(kwhForDistance(100)).toBeCloseTo(17.5, 1);
    expect(kwhForDistance(300)).toBeCloseTo(52.5, 1);
  });

  it('SoC falls correctly over a 300 km leg from 100%', () => {
    // 52.5 kWh of 75 kWh pack = 70% consumed -> 30% SoC... but note usable
    // energy: we report SoC against nominal 75, so 100 - 52.5/75*100 = 30%.
    const soc = socAfterDriving(300, 100);
    expect(soc).toBeCloseTo(30, 0);
  });

  it('SoC never goes negative', () => {
    expect(socAfterDriving(1000, 20)).toBe(0);
  });

  it('flat-region charge time is energy/power', () => {
    // 50 -> 80% at a 120 kW charger: car caps at 70 kW.
    // energy = 0.30 * 71.25 = 21.375 kWh -> 18.32 min
    const t = chargeTimeMin(50, 80, 120);
    expect(t).toBeCloseTo(18.3, 1);
  });

  it('slower charger slows charging (60 kW cap)', () => {
    const t = chargeTimeMin(50, 80, 60);
    // energy = 21.375 kWh / 60 kW -> 21.375 min
    expect(t).toBeCloseTo(21.4, 1);
  });

  it('taper region above 80% charges slower per kWh', () => {
    const flat = chargeTimeMin(50, 80, 70); // 21.375 kWh
    const taper = chargeTimeMin(80, 100, 70); // 14.25 kWh
    // per-kWh charge time must rise once inside the taper
    const flatRate = flat / 21.375;
    const taperRate = taper / 14.25;
    expect(taperRate).toBeGreaterThan(flatRate * 1.3);
    // absolute sanity: ~14.25 kWh at ~47 kW average is ~18-20 min
    expect(taper).toBeGreaterThan(17);
    expect(taper).toBeLessThan(24);
  });

  it('kwh delta matches SoC span over usable energy', () => {
    expect(kwhForSocDelta(20, 80)).toBeCloseTo(0.6 * 71.25, 2);
  });

  it('charge time is zero for degenerate inputs', () => {
    expect(chargeTimeMin(80, 50, 70)).toBe(0);
    expect(chargeTimeMin(50, 50, 70)).toBe(0);
    expect(chargeTimeMin(10, 80, 0)).toBe(0);
  });
});
