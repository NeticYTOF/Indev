// Live smoke test: real OSRM routing + real Statiq API planning.
// Usage: node --env-file=.env npx tsx scripts/plan-live.ts
//
// Owner acceptance cases:
//   1) Delhi -> Jaipur  (~285 km): expect 0 stops from 100%
//   2) Mumbai -> Prayagraj (~1432 km): expect about 4 stops
import {
  DEFAULT_PLAN_OPTIONS,
  OsrmRouter,
  PhotonGeocoder,
  PlanningError,
  StatiqClient,
  planTrip,
} from '../packages/core/src/index.js';

const token = process.env.STATIQ_API_TOKEN;
if (!token) {
  console.error('STATIQ_API_TOKEN is missing: add it to .env first.');
  process.exit(1);
}

const statiq = new StatiqClient({ token }); // fresh client per run (memo policy)
const router = new OsrmRouter();
const geocoder = new PhotonGeocoder();

async function resolvePlace(query: string) {
  const hits = await geocoder.search(query, 1);
  const hit = hits[0];
  if (!hit) throw new Error(`Could not geocode "${query}"`);
  return { label: hit.label, lat: hit.lat, lon: hit.lon };
}

function fmtPlan(plan: Awaited<ReturnType<typeof planTrip>>): string {
  const lines: string[] = [];
  lines.push(`Route: ${plan.origin.label} -> ${plan.destination.label}`);
  lines.push(`  distance ${plan.routeDistanceKm.toFixed(1)} km, driving ${Math.round(plan.routeDurationMin)} min`);
  lines.push(`  stops: ${plan.stops.length}`);
  for (const s of plan.stops) {
    lines.push(
      `  #${s.station.stationId} ${s.station.name} [${s.station.brand}] ch=${s.chainageKm.toFixed(0)}km ` +
        `leg=${s.legKm.toFixed(0)}km detour=${s.detourKm.toFixed(1)}km ` +
        `soc ${s.arriveSocPct.toFixed(0)}%->${s.leaveSocPct.toFixed(0)}% ` +
        `${s.chargeKwh.toFixed(1)}kWh @${s.pricePerKwh ?? '?'}Rs/kWh = Rs.${s.estPriceInr ?? '?'} ` +
        `${s.chargeTimeMin}min rating=${s.station.rating ?? '-'} reviews=${s.station.reviewCount ?? '-'}`,
    );
  }
  lines.push(
    `  totals: charge ${plan.totals.chargeKwh.toFixed(1)} kWh, Rs.${plan.totals.estPriceInr ?? '?'}, ` +
      `charge ${Math.round(plan.totals.chargeTimeMin)} min, total ${Math.round(plan.totals.totalTimeMin)} min, ` +
      `arrive ${plan.totals.finalSocPct}%`,
  );
  lines.push(`  stations seen this run: ${plan.stationsSeen}`);
  if (plan.warnings.length) lines.push(`  warnings: ${plan.warnings.join(' | ')}`);
  return lines.join('\n');
}

const cases: Array<[string, string, number]> = [
  ['Delhi', 'Jaipur', 0], // ~285 km: no stops from full charge
  ['Mumbai', 'Prayagraj', 5], // ~1432 km: expect ~4 stops (allow up to 5)
];

let failures = 0;
for (const [from, to, maxStops] of cases) {
  const origin = await resolvePlace(from);
  const destination = await resolvePlace(to);
  const t0 = Date.now();
  try {
    const plan = await planTrip({ router, statiq }, origin, destination, {
      ...DEFAULT_PLAN_OPTIONS,
    });
    console.log(`\n== ${from} -> ${to} (${((Date.now() - t0) / 1000).toFixed(1)}s) ==`);
    console.log(fmtPlan(plan));
    const expectedStops = maxStops === 0 ? 0 : undefined;
    if (expectedStops !== undefined && plan.stops.length !== expectedStops) {
      failures++;
      console.error(`  EXPECTED exactly ${expectedStops} stops, got ${plan.stops.length}`);
    }
    if (maxStops > 0 && plan.stops.length > maxStops) {
      failures++;
      console.error(`  EXPECTED at most ${maxStops} stops, got ${plan.stops.length}`);
    }
    for (const s of plan.stops) {
      if (s.legKm > DEFAULT_PLAN_OPTIONS.maxLegKm + 10) {
        failures++;
        console.error(`  LEG TOO LONG: ${s.legKm.toFixed(0)} km`);
      }
      if (s.arriveSocPct < DEFAULT_PLAN_OPTIONS.minArrivalSocPct - 0.5) {
        failures++;
        console.error(`  ARRIVAL BELOW MINIMUM: ${s.arriveSocPct.toFixed(1)}%`);
      }
    }
  } catch (err) {
    failures++;
    console.error(`\n== ${from} -> ${to} FAILED ==`);
    console.error(err instanceof PlanningError ? err.message : err);
  }
}

console.log(failures === 0 ? '\nALL LIVE CHECKS PASSED' : `\n${failures} LIVE CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
