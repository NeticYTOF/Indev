/** Additive current-new advisory view over the full current candidate pool. */
import type { Coords, VehicleConfig } from '@indeev/core';
import { buildReachabilityGuidance,
  type GuidanceOptions, type GuidancePoint, type ReachabilityGuidance } from './reachability-guidance.js';

export const CURRENT_NEW_ADVISORY_SCOPE = 'current_new_advisory' as const;

export interface CurrentNewAdvisory extends ReachabilityGuidance {
  scope: typeof CURRENT_NEW_ADVISORY_SCOPE;
  semantics: string;
}

const CAVEAT_SUFFIX =
  ' Current-new advisory view is estimated initial/current-best-frontier exploration only; ' +
  'not live certification, budget permission, absence of future candidates, actual-road feasibility, ' +
  'or genuine necessity. A zero count is not a global absence claim.';
const SEMANTICS =
  'Current-new candidate and sample scope is the full current pool minus prior-history and this-run checked IDs. ' +
  'chain.stationIds and certifiedChainCandidateCount preserve ALL freshly certified IDs, including prior IDs. ' +
  'Counts cover all eligible advisory points; lists are bounded samples. ' +
  'This is exploration guidance only: not certification, permission, road feasibility, necessity, ' +
  'or proof that no future candidates exist; zero is not a global absence claim.';

export function buildCurrentNewAdvisory(input: {
  routeKm: number;
  candidates: readonly GuidancePoint[];
  certified: readonly GuidancePoint[];
  excludedIds: ReadonlySet<number>;
  opts: GuidanceOptions;
  vehicle: VehicleConfig;
  geometry?: readonly Coords[];
}): CurrentNewAdvisory {
  const eligible = input.candidates.filter((point) => !input.excludedIds.has(point.stationId));
  const guidance = buildReachabilityGuidance(
    input.routeKm, eligible, input.certified, new Set<number>(),
    input.opts, input.vehicle, input.geometry,
  );
  return {
    ...guidance,
    scope: CURRENT_NEW_ADVISORY_SCOPE,
    semantics: SEMANTICS,
    caveat: guidance.caveat + CAVEAT_SUFFIX,
  };
}

export function currentNewAdvisoryChanges(
  initial: CurrentNewAdvisory, current: CurrentNewAdvisory,
): Partial<CurrentNewAdvisory> {
  const changes: Record<string, unknown> = {};
  const before = initial as unknown as Record<string, unknown>;
  for (const [field, value] of Object.entries(current)) {
    if (field === 'scope' || field === 'semantics') continue;
    if (JSON.stringify(before[field]) !== JSON.stringify(value)) changes[field] = value;
  }
  return changes as Partial<CurrentNewAdvisory>;
}
