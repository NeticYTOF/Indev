/** Builds one opaque 64-hex scope digest. Raw labels and prompts are never stored. */
import { createHash } from 'node:crypto';
import { resolvePlanOptions, type PlaceRef, type PlanOptions, type ResolvedVehicle } from '@indeev/core';
import type { SelectiveCoverageProfile } from './selective-tools.js';

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
function pair(point: PlaceRef): [number, number] {
  return [point.lat, point.lon];
}

export function buildCheckedIdScopeKey(input: {
  origin: PlaceRef;
  destination: PlaceRef;
  via: readonly PlaceRef[];
  resolved: ResolvedVehicle;
  planOptions: PlanOptions;
  coverageProfile: SelectiveCoverageProfile;
  customRequest?: string;
}): string {
  const opts = resolvePlanOptions(input.planOptions);
  const config = input.resolved.config;
  const material = {
    v: 1,
    trip: {
      origin: pair(input.origin),
      destination: pair(input.destination),
      via: input.via.map(pair),
    },
    vehicle: {
      batteryKwh: config.batteryKwh,
      usableFraction: config.usableFraction,
      whPerKm: config.whPerKm,
      maxDcKw: config.maxDcKw,
      taperStartSocPct: config.taperStartSocPct,
      taperEndPowerKw: config.taperEndPowerKw,
      catalogId: input.resolved.catalogId,
      batteryKwhResolved: input.resolved.batteryKwh,
      claimedRangeKm: input.resolved.claimedRangeKm,
      realWorldRangeKm: input.resolved.realWorldRangeKm,
    },
    options: {
      startSocPct: opts.startSocPct,
      minArrivalSocPct: opts.minArrivalSocPct,
      absoluteMaxSocPct: opts.absoluteMaxSocPct,
      maxLegKm: opts.maxLegKm,
      maxChargerKw: Number.isFinite(opts.maxChargerKw) ? opts.maxChargerKw : 'none',
      reservePct: opts.reservePct ?? null,
      targetSoc: opts.targetSoc ?? null,
      coverageProfile: input.coverageProfile,
    },
    requestDigest: hash(input.customRequest ?? ''),
  };
  return hash(JSON.stringify(material));
}
