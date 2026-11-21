/**
 * Bounded, allowlisted tool contract for the AI-first selective engine.
 *
 * The only tool is get_station_details(ids). IDs must come from the current
 * on-route candidate set; no URLs, headers, bodies, free text or arbitrary
 * identifiers are accepted. Facts are read from CORE-HYDRATED candidates
 * (Ccs2Summary + StationLiveView + selectedCharger), never from raw upstream
 * shorthand. Missing values stay unknown. Tool text is DATA, not instructions.
 */
import type { PlannerCandidate, PlanSelectedCharger } from '@indeev/core';

export interface SelectiveToolBudget {
  maxRounds: number;
  maxToolCalls: number;
  maxIdsPerCall: number;
  maxTotalIds: number;
}

export const DEFAULT_SELECTIVE_TOOL_BUDGET: SelectiveToolBudget = {
  maxRounds: 4, maxToolCalls: 12, maxIdsPerCall: 5, maxTotalIds: 20,
};

export interface AdmittedToolCall {
  ids: number[];
  newIds: number[];
  memoIds: number[];
}

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export class SelectiveToolLedger {
  rounds = 0;
  calls = 0;
  /** Reserved for fetch, not a completion count. */
  plannedNewIds = 0;
  actualFetches = 0;
  readonly admitted = new Set<number>();
  private readonly pool: ReadonlySet<number>;
  readonly limits: SelectiveToolBudget;

  constructor(allowed: ReadonlySet<number>, budget: SelectiveToolBudget = DEFAULT_SELECTIVE_TOOL_BUDGET) {
    for (const value of [budget.maxRounds, budget.maxToolCalls, budget.maxIdsPerCall, budget.maxTotalIds]) {
      if (!positiveInt(value)) throw new Error('Selective tool budget requires positive safe integers');
    }
    this.pool = new Set(allowed);
    this.limits = { ...budget };
  }

  nextRound(signal?: AbortSignal): boolean {
    if (signal?.aborted || this.rounds >= this.limits.maxRounds) return false;
    this.rounds += 1;
    return true;
  }

  admit(raw: unknown, signal?: AbortSignal): AdmittedToolCall | null {
    if (signal?.aborted || this.calls >= this.limits.maxToolCalls) return null;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    if (Object.getPrototypeOf(raw) !== Object.prototype) return null;
    const keys = Object.keys(raw);
    if (keys.length !== 1 || keys[0] !== 'ids') return null;
    const ids = (raw as { ids?: unknown }).ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > this.limits.maxIdsPerCall) return null;
    const seen = new Set<number>();
    const newIds: number[] = [];
    const memoIds: number[] = [];
    for (const id of ids) {
      if (!positiveInt(id) || seen.has(id) || !this.pool.has(id)) return null;
      seen.add(id);
      if (this.admitted.has(id)) memoIds.push(id); else newIds.push(id);
    }
    if (this.admitted.size + newIds.length > this.limits.maxTotalIds) return null;
    for (const id of seen) this.admitted.add(id);
    this.calls += 1;
    this.plannedNewIds += newIds.length;
    return { ids: [...seen], newIds, memoIds };
  }

  /** Called by the host only after a real detail fetch settles. */
  recordFetches(count: number): void {
    if (Number.isSafeInteger(count) && count >= 0) this.actualFetches += count;
  }
}

export interface ChargerFact {
  chargerId: number;
  name: string;
  type: string;
  kw: number | null;
  pricePerKwh: number | null;
}

/** AI-visible projection only. Occupancy, plug health and status are
 *  deliberately absent: the owner's standing instruction is that the model
 *  is offered working-compatible CCS2 without being told it is occupied. */
export interface StationFact {
  stationId: number;
  fetchedAt: string | null;
  live: boolean | null;
  source: string | null;
  maxKw: number | null;
  pricePerKwh: number | null;
  usableCcs2Count: number;
  hasUsableCcs2: boolean;
  chargers: ChargerFact[];
  selectedCharger: PlanSelectedCharger | null;
  hours: string | null;
  reliability: null;
  reliabilityNote: string;
  unknowns: string[];
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Facts come from a hydrated candidate only. No raw API shorthand, no
 *  first-charger tariff, no zero-as-empty charger count, no invented status. */
export function factsFromHydrated(
  candidate: PlannerCandidate,
  source: string | null,
  live: boolean | null,
): StationFact {
  const view = candidate.view;
  const summary = candidate.summary;
  const selected = candidate.selectedCharger ?? null;
  const chargers: ChargerFact[] = (view.chargers ?? []).map((ch) => ({
    chargerId: ch.chargerId,
    name: ch.name,
    type: ch.type,
    kw: nonNegative(ch.kw),
    pricePerKwh: nonNegative(ch.pricePerKwh),
  }));
  const maxKw = selected ? positive(selected.kw) : positive(summary.maxKw);
  const pricePerKwh = selected ? nonNegative(selected.pricePerKwh) : null;
  const unknowns: string[] = [];
  if (live == null) unknowns.push('live');
  if (!view.fetchedAt) unknowns.push('fetchedAt');
  if (maxKw == null) unknowns.push('usable power');
  if (pricePerKwh == null) unknowns.push('selected tariff');
  if (chargers.length === 0) unknowns.push('chargers');

  unknowns.push('reliability');
  return {
    stationId: candidate.candidate.stationId,
    fetchedAt: view.fetchedAt || null,
    live, source, maxKw, pricePerKwh,
    usableCcs2Count: summary.usable, hasUsableCcs2: summary.isUsable,
    chargers, selectedCharger: selected,
    hours: view.hours ?? view.openText ?? null,
    reliability: null,
    reliabilityNote: 'No verified reliability score is available.',
    unknowns,
  };
}
