/**
 * Tata Harrier EV 75 kWh battery model.
 *
 * OWNER-SUPPLIED FACTS (the only two):
 * - 75 kWh nominal pack.
 * - 300 km safe running range (enforced by the planner's max-leg rule).
 *
 * Everything else in MODEL_WORKING_ESTIMATES below is a WORKING ESTIMATE:
 * unvalidated, not owner-approved, gathered to make the planner produce
 * reasonable plans. Correct them there when better data exists. Do not
 * describe this model as physically validated.
 */
import type { Coords } from './geo.js';

/**
 * ONE place for every working estimate in the vehicle model.
 * - usableFraction: packs hold a small brick charge at the bottom.
 * - defaultWhPerKm: rough highway consumption for a mid-size Indian EV SUV.
 * - maxDcKw / taper: generic fast-charge curve shape (NOT a published spec).
 */
export const MODEL_WORKING_ESTIMATES = {
  usableFraction: 0.95,
  defaultWhPerKm: 175,
  maxDcKw: 70,
  taperStartSocPct: 80,
  taperEndPowerKw: 24,
} as const;

export interface VehicleConfig {
  /** Nominal pack size, kWh. */
  batteryKwh: number;
  /** WORKING ESTIMATE: fraction of the pack usable in practice. */
  usableFraction: number;
  /** Consumption, Wh per km (derived from user's real-world range when given). */
  whPerKm: number;
  /** WORKING ESTIMATE: max DC power the car can take, kW. */
  maxDcKw: number;
  /** WORKING ESTIMATE: SoC % where the charge curve starts tapering. */
  taperStartSocPct: number;
  /** WORKING ESTIMATE: effective power at 100% SoC, kW. */
  taperEndPowerKw: number;
}

export const HARIER_EV_75: VehicleConfig = {
  batteryKwh: 75, // owner-supplied
  usableFraction: MODEL_WORKING_ESTIMATES.usableFraction,
  whPerKm: MODEL_WORKING_ESTIMATES.defaultWhPerKm,
  maxDcKw: MODEL_WORKING_ESTIMATES.maxDcKw,
  taperStartSocPct: MODEL_WORKING_ESTIMATES.taperStartSocPct,
  taperEndPowerKw: MODEL_WORKING_ESTIMATES.taperEndPowerKw,
};

/** State of charge in percent — OF USABLE energy (see the convention note). */
export type SocPct = number;

/*
 * CONVENTION: SoC % is percent of USABLE energy (usable = nominal x
 * usableFraction). 100% SoC = usableKwh, 0% = empty at the brick floor.
 * This keeps every SoC/energy conversion coherent through a single factor,
 * `100 / usableKwh`. Nominal pack size is display metadata only.
 */

export function usableKwh(v: VehicleConfig): number {
  return v.batteryKwh * v.usableFraction;
}

/** kWh consumed driving `km`, flat-consumption model. */
export function kwhForDistance(km: number, v: VehicleConfig = HARIER_EV_75): number {
  return (km * v.whPerKm) / 1000;
}

/** SoC % after driving `km` starting from `startSocPct`; floors at 0. */
export function socAfterDriving(
  km: number,
  startSocPct: SocPct,
  v: VehicleConfig = HARIER_EV_75,
): SocPct {
  const consumedKwh = kwhForDistance(km, v);
  const pctPerKwh = 100 / usableKwh(v);
  return Math.max(0, startSocPct - consumedKwh * pctPerKwh);
}

/**
 * Departure SoC % required so that after driving `km` the battery sits at
 * `targetSocPct`. Inverse of socAfterDriving; caps at 100.
 */
export function socRequiredForArrival(
  km: number,
  targetSocPct: SocPct,
  v: VehicleConfig = HARIER_EV_75,
): SocPct {
  const consumedKwh = kwhForDistance(km, v);
  const pctPerKwh = 100 / usableKwh(v);
  return Math.min(100, targetSocPct + consumedKwh * pctPerKwh);
}

/**
 * Effective charge power (kW) at a given SoC for a station's charger,
 * tapering above `taperStartSocPct` toward `taperEndPowerKw` at 100%.
 */
export function chargePowerKw(socPct: SocPct, chargerKw: number, v: VehicleConfig = HARIER_EV_75): number {
  const base = Math.min(chargerKw, v.maxDcKw);
  if (socPct <= v.taperStartSocPct) return base;
  const t = Math.min(1, Math.max(0, (socPct - v.taperStartSocPct) / (100 - v.taperStartSocPct)));
  return base + (v.taperEndPowerKw - base) * t;
}

/**
 * Minutes to charge from `fromPct` to `toPct` at a `chargerKw` station,
 * integrating the taper curve in 1% steps.
 */
export function chargeTimeMin(
  fromPct: SocPct,
  toPct: SocPct,
  chargerKw: number,
  v: VehicleConfig = HARIER_EV_75,
): number {
  if (toPct <= fromPct || chargerKw <= 0) return 0;
  const usable = usableKwh(v);
  const kwhPerPct = usable / 100;
  let minutes = 0;
  let soc = fromPct;
  while (soc < toPct - 1e-9) {
    const step = Math.min(1, toPct - soc);
    const power = chargePowerKw(soc, chargerKw, v);
    if (power <= 0) return Number.POSITIVE_INFINITY;
    minutes += (kwhPerPct * step) / power * 60;
    soc += step;
  }
  return minutes;
}

/** Energy (kWh) added when moving SoC from `fromPct` to `toPct`. */
export function kwhForSocDelta(
  fromPct: SocPct,
  toPct: SocPct,
  v: VehicleConfig = HARIER_EV_75,
): number {
  return ((toPct - fromPct) / 100) * usableKwh(v);
}

/** Rough driving minutes for a leg at a given average speed. */
export function driveTimeMin(km: number, avgSpeedKmh: number): number {
  if (avgSpeedKmh <= 0) return Number.POSITIVE_INFINITY;
  return (km / avgSpeedKmh) * 60;
}

export type { Coords };
