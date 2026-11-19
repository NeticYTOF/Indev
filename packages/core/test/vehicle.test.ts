import { describe, expect, it } from 'vitest';
import {
  HARIER_EV_75,
  chargeTimeMin,
  kwhForDistance,
  kwhForSocDelta,
  socAfterDriving,
  socRequiredForArrival,
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

  it('SoC falls correctly over a 300 km leg from 100% (usable-based SoC)', () => {
    // 52.5 kWh of 71.25 usable = 73.7% consumed -> 26.3% SoC
    const soc = socAfterDriving(300, 100);
    expect(soc).toBeCloseTo(26.3, 1);
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

describe('capacity split coherence (nominal vs usable)', () => {
  it('SoC percent is over USABLE energy; nominal is display metadata', () => {
    // charging 0 -> 100% adds exactly the usable energy
    expect(kwhForSocDelta(0, 100)).toBeCloseTo(usableKwh(HARIER_EV_75), 6);
    // discharging 100 -> 0% releases the usable energy
    expect(kwhForSocDelta(100, 0)).toBeCloseTo(-usableKwh(HARIER_EV_75), 6);
    // 1% SoC is 1/100th of usable, NOT of nominal (the old incoherence)
    expect(Math.abs(kwhForSocDelta(0, 1))).toBeCloseTo(usableKwh(HARIER_EV_75) / 100, 9);
  });

  it('driving consumes usable-consistent SoC: energy removed equals energy consumed', () => {
    for (const km of [1, 20, 45.5, 80, 137, 250]) {
      const soc = socAfterDriving(km, 100);
      if (soc > 0) {
        const kwhRemoved = -kwhForSocDelta(100, soc);
        const kwhConsumed = (km * HARIER_EV_75.whPerKm) / 1000;
        expect(kwhRemoved).toBeCloseTo(kwhConsumed, 6);
      }
    }
  });

  it('socAfterDriving and socRequiredForArrival are exact inverses', () => {
    for (const km of [0, 17, 64.3, 120, 299]) {
      const target = 12;
      const dep = socRequiredForArrival(km, target);
      expect(socAfterDriving(km, dep)).toBeCloseTo(target, 9);
    }
  });

  it('reserve math uses the same split: min-arrival SoC maps to usable energy', () => {
    const minArrival = 10;
    expect(Math.abs(kwhForSocDelta(0, minArrival))).toBeCloseTo(7.125, 3); // 10% of usable 71.25
    // and driving exactly that reserve down from 10% lands at 0%
    const km = 7.125 / (HARIER_EV_75.whPerKm / 1000);
    expect(socAfterDriving(km, 10)).toBeCloseTo(0, 9);
  });
});
