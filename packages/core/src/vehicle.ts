/**
 * Tata Harrier EV 75 kWh battery model.
 *
 * Numbers are documented assumptions (not official specs beyond capacity):
 * - usableFraction 0.95: packs hold a small brick charge at the bottom.
 * - whPerKm 175: real-world Indian highway speeds with AC -> a ~407 km
 *   full range. The owner's "300 km safe running range" couples this with
 *   the planner's 300 km max-gap rule.
 * - maxDcKw 70: the car's DC intake. Station charger power above this is
 *   capped; taper above 80% SoC approximates the real curve (fast to 80,
 *   then a slowing knee).
 */
import type { Coords } from './geo.js';

export interface VehicleConfig {
  /** Nominal pack size, kWh. */
  batteryKwh: number;
  /** Fraction of the pack usable in practice. */
  usableFraction: number;
  /** Consumption, Wh per km, highway conditions. */
  whPerKm: number;
  /** Max DC power the car can take, kW. */
  maxDcKw: number;
  /** SoC % where the charge curve starts tapering. */
  taperStartSocPct: number;
  /** Effective power at 100% SoC, kW. */
  taperEndPowerKw: number;
}

export const HARIER_EV_75: VehicleConfig = {
  batteryKwh: 75,
  usableFraction: 0.95,
  whPerKm: 175,
  maxDcKw: 70,
  taperStartSocPct: 80,
  taperEndPowerKw: 24,
};

/** State of charge in percent of the nominal pack. */
export type SocPct = number;

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
  const pctPerKwh = 100 / v.batteryKwh;
  return Math.max(0, startSocPct - consumedKwh * pctPerKwh);
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
