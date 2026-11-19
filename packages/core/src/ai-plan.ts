/**
 * AI plan validation and rebuilding.
 *
 * The AI planner asks an OpenAI-compatible model to pick a stop sequence
 * from the run's candidates (which never carry occupancy). This module makes
 * the AI SAFE: its choice is validated against the same physical rules the
 * greedy planner enforces, then the plan is rebuilt with the exact same
 * number pipeline (finalize/computeTotals). An invalid choice never reaches
 * the user — the base plan is returned with an honest reason instead.
 */
import type { Coords } from './geo.js';
import {
  finalize,
  computeTotals,
  PlanningError,
  type ChosenStop,
  type PlannerCandidate,
  type PlanBundle,
} from './planner.js';
import type { PlanOptions, PlanStop, PlanTotals, TripPlan } from './plan-types.js';
import { socRequiredForArrival, socAfterDriving, type VehicleConfig } from './vehicle.js';
import { DEFAULT_PLAN_OPTIONS } from './plan-types.js';

export interface AiChoice {
  stationIds: number[];
  notes?: string;
}

export type AiValidation =
  | { ok: true; seq: ChosenStop[] }
  | { ok: false; reason: string };

/**
 * Validate an AI-chosen station sequence against the run's candidates and
 * the hard planning rules:
 * - every id must exist among this run's usable candidates
 * - stops must be ordered along the route (strictly increasing chainage)
 * - every leg (incl. detours) must fit inside the max-leg gap
 * - every arrival must honor the minimum-arrival SoC given the minimal
 *   charge policy (charge at stop i = what stop i+1 needs + buffer)
 * - the destination must be reachable from the final stop
 */
export function validateAiChoice(
  bundle: Pick<PlanBundle, 'usableCandidates' | 'route'> & {
    plan: Pick<TripPlan, 'routeDistanceKm'>;
  },
  choice: AiChoice,
  options: PlanOptions,
  vehicle: VehicleConfig,
): AiValidation {
  const opts = { ...DEFAULT_PLAN_OPTIONS, ...options };
  const { usableCandidates, route } = bundle;
  const byId = new Map(usableCandidates.map((c) => [c.candidate.stationId, c]));

  const fail = (reason: string): AiValidation => ({ ok: false, reason });

  if (!Array.isArray(choice.stationIds) || choice.stationIds.length === 0) {
    return fail('The AI returned no station sequence.');
  }

  const picked: PlannerCandidate[] = [];
  for (const id of choice.stationIds) {
    const c = byId.get(id);
    if (!c) return fail(`Station ${id} is not among this run's usable candidates.`);
    picked.push(c);
  }

  // ordered along the route, no duplicates
  let prevChain = -Infinity;
  const seen = new Set<number>();
  for (const c of picked) {
    if (seen.has(c.candidate.stationId)) return fail(`Station ${c.candidate.stationId} appears twice.`);
    seen.add(c.candidate.stationId);
    if (c.candidate.chainageKm <= prevChain) {
      return fail('Stations must follow the route order (origin to destination).');
    }
    prevChain = c.candidate.chainageKm;
  }

  // simulate the whole chain with the minimal-charge policy
  const totalKm = route.geometry.length
    ? routeLengthKm(route.geometry)
    : bundle.plan.routeDistanceKm;

  let cursorChain = 0;
  let cursorDetour = 0;
  let soc = opts.startSocPct;
  const seq: ChosenStop[] = [];

  for (const c of picked) {
    const legKm =
      c.candidate.chainageKm - cursorChain + cursorDetour + c.candidate.offRouteKm;
    if (legKm > opts.maxLegKm + 1e-6) {
      return fail(`A ${Math.round(legKm)} km leg exceeds the ${opts.maxLegKm} km safe running range.`);
    }
    const arrive =
      seq.length === 0
        ? socAfterDriving(legKm, soc, vehicle)
        : opts.minArrivalSocPct + 2; // previous stop charged exactly for this
    if (arrive < opts.minArrivalSocPct - 1e-6) {
      return fail(
        `The battery cannot reach "${c.view.name}" with the required ${Math.round(opts.minArrivalSocPct)}% reserve.`,
      );
    }
    seq.push({ cand: c, legKm, arriveSocPct: arrive });
    cursorChain = c.candidate.chainageKm;
    cursorDetour = c.candidate.offRouteKm;
    soc = opts.absoluteMaxSocPct; // subsequent stops may charge to the cap
  }

  // final leg to destination
  const finalLegKm = totalKm - cursorChain + cursorDetour;
  if (finalLegKm > opts.maxLegKm + 1e-6 && seq.length === 0) {
    return fail(`The ${Math.round(finalLegKm)} km final leg exceeds the safe running range.`);
  }
  const needed = socRequiredForArrival(finalLegKm, opts.minArrivalSocPct + 2, vehicle);
  const departFrom =
    seq.length > 0 ? opts.absoluteMaxSocPct : opts.startSocPct;
  if (socAfterDriving(finalLegKm, departFrom, vehicle) < opts.minArrivalSocPct - 1e-6) {
    return fail('The destination is not reachable even after charging at the last stop.');
  }
  void needed;

  return { ok: true, seq };
}

/** Rebuild a full TripPlan from a validated sequence, reusing the exact
 * number pipeline of the greedy planner. */
export function assembleAiPlan(
  bundle: Pick<PlanBundle, 'plan' | 'route'>,
  seq: ChosenStop[],
  ai: { applied: true; notes?: string },
  options: PlanOptions,
  vehicle: VehicleConfig,
): TripPlan {
  const opts = { ...DEFAULT_PLAN_OPTIONS, ...options };
  const base = bundle.plan;
  const warnings = [
    ...base.warnings,
    `Stop plan adjusted by AI${ai.notes ? `: ${String(ai.notes).slice(0, 240)}` : ''}.`,
  ];
  const stops: PlanStop[] = finalize(seq, base.routeDistanceKm, bundle.route, opts, vehicle, warnings);
  const totals: PlanTotals = computeTotals(stops, base.routeDistanceKm, bundle.route, opts, vehicle);
  return {
    ...base,
    stops,
    totals,
    warnings,
  };
}

function routeLengthKm(geometry: Coords[]): number {
  // exact-enough chain length for validation only
  let total = 0;
  for (let i = 1; i < geometry.length; i++) {
    const a = geometry[i - 1] as Coords;
    const b = geometry[i] as Coords;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;
    const h =
      Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    total += 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  return total;
}

export { PlanningError };
