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
export type SelectiveCoverageProfile = 'standard20' | 'progressive40';
export const SELECTIVE_TOOL_BUDGETS: Record<SelectiveCoverageProfile, SelectiveToolBudget> = {
  standard20: { maxRounds: 4, maxToolCalls: 12, maxIdsPerCall: 5, maxTotalIds: 20 },
  progressive40: { maxRounds: 8, maxToolCalls: 12, maxIdsPerCall: 5, maxTotalIds: 40 },
};

export type ToolAdmissionRejectReason =
  'aborted' | 'call_cap' | 'invalid_shape' | 'invalid_id' |
  'duplicate_id' | 'unknown_id' | 'total_cap';
export interface ToolAdmissionAggregate {
  attemptedCalls: number;
  admittedCalls: number;
  rejectedCalls: number;
  rejectedByReason: Record<ToolAdmissionRejectReason, number>;
  requestedIds: number;
  newIds: number;
  memoIds: number;
}
export function emptyAdmissionAggregate(): ToolAdmissionAggregate {
  return {
    attemptedCalls: 0, admittedCalls: 0, rejectedCalls: 0,
    rejectedByReason: {
      aborted: 0, call_cap: 0, invalid_shape: 0, invalid_id: 0,
      duplicate_id: 0, unknown_id: 0, total_cap: 0,
    },
    requestedIds: 0, newIds: 0, memoIds: 0,
  };
}
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
  readonly admission: ToolAdmissionAggregate = emptyAdmissionAggregate();

  constructor(allowed: ReadonlySet<number>, budget: SelectiveToolBudget = DEFAULT_SELECTIVE_TOOL_BUDGET) {
    for (const value of [budget.maxRounds, budget.maxToolCalls, budget.maxIdsPerCall, budget.maxTotalIds]) {
      if (!positiveInt(value)) throw new Error('Selective tool budget requires positive safe integers');
    }
    if (budget.maxToolCalls * budget.maxIdsPerCall < budget.maxTotalIds) {
      throw new Error('Selective tool budget cannot admit its total IDs within its call limit');
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
    const reject = (reason: ToolAdmissionRejectReason): null => {
      this.admission.rejectedCalls += 1;
      this.admission.rejectedByReason[reason] += 1;
      return null;
    };
    this.admission.attemptedCalls += 1;
    if (signal?.aborted) return reject('aborted');
    if (this.calls >= this.limits.maxToolCalls) return reject('call_cap');
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw) ||
        Object.getPrototypeOf(raw) !== Object.prototype) return reject('invalid_shape');
    const keys = Object.keys(raw);
    if (keys.length !== 1 || keys[0] !== 'ids') return reject('invalid_shape');
    const ids = 'ids' in raw ? raw.ids : undefined;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > this.limits.maxIdsPerCall) {
      return reject('invalid_shape');
    }
    this.admission.requestedIds += ids.length;
    const seen = new Set<number>();
    const newIds: number[] = [];
    const memoIds: number[] = [];
    for (const id of ids) {
      if (!positiveInt(id)) return reject('invalid_id');
      if (seen.has(id)) return reject('duplicate_id');
      if (!this.pool.has(id)) return reject('unknown_id');
      seen.add(id);
      if (this.admitted.has(id)) memoIds.push(id); else newIds.push(id);
    }
    if (this.admitted.size + newIds.length > this.limits.maxTotalIds) return reject('total_cap');
    for (const id of seen) this.admitted.add(id);
    this.calls += 1;
    this.plannedNewIds += newIds.length;
    this.admission.admittedCalls += 1;
    this.admission.newIds += newIds.length;
    this.admission.memoIds += memoIds.length;
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
