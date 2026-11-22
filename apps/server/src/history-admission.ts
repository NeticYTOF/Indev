/**
 * Quota-free, pure admission policy for IDs-only prior-run history.
 * No fetch, no replacement IDs, no guidance changes, no production default.
 * The AI batch and current allowlist stay authoritative. Prior IDs are only
 * intersected with the current pool; stale or malformed history disables
 * historical policy without invalidating a valid AI request.
 */
export interface HistoryAdmissionInput {
  currentPoolIds: readonly number[];
  aiRequestedIds: readonly number[];
  priorCheckedIds: readonly number[];
  currentRunAdmittedIds: readonly number[];
  historyAvailable: boolean;
  historicalRefreshReason?: 'necessary_bridge';
}
export interface HistoryAdmissionResult {
  ok: true;
  admittedIds: number[];
  deferredIds: number[];
  reasonByRequestedId: Record<string, string>;
  memoizedIds: number[];
  deferredCount: number;
  priorCheckedCount: number;
  historyStatus: 'active' | 'unavailable';
  historyIgnoredIds: number[];
}
export type HistoryAdmissionOutcome =
  | HistoryAdmissionResult
  | { ok: false; reason: 'invalid_request' };

function validId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function validUniqueArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every(validId) && new Set(value).size === value.length;
}

export function admitWithCheckedIdHistory(input: HistoryAdmissionInput): HistoryAdmissionOutcome {
  const pool = input.currentPoolIds;
  const requested = input.aiRequestedIds;
  if (!validUniqueArray(pool) || !validUniqueArray(requested) ||
      requested.length === 0 || requested.length > 5 ||
      (input.historicalRefreshReason !== undefined &&
        input.historicalRefreshReason !== 'necessary_bridge')) {
    return { ok: false, reason: 'invalid_request' };
  }
  const poolSet = new Set(pool);
  if (requested.some((id) => !poolSet.has(id))) return { ok: false, reason: 'invalid_request' };

  const usableHistory = input.historyAvailable === true && validUniqueArray(input.priorCheckedIds);
  const priorIds = usableHistory ? input.priorCheckedIds : [];
  const priorSet = new Set<number>();
  const historyIgnoredIds: number[] = [];
  for (const id of priorIds) {
    if (poolSet.has(id)) priorSet.add(id);
    else historyIgnoredIds.push(id);
  }
  const currentIds = validUniqueArray(input.currentRunAdmittedIds)
    ? input.currentRunAdmittedIds.filter((id) => poolSet.has(id)) : [];
  const currentSet = new Set(currentIds);
  const unattemptedCurrentNew = pool.filter((id) => !priorSet.has(id) && !currentSet.has(id));

  const admittedIds: number[] = [];
  const deferredIds: number[] = [];
  const reasonByRequestedId: Record<string, string> = {};
  const memoizedIds: number[] = [];
  for (const id of requested) {
    if (currentSet.has(id)) {
      admittedIds.push(id);
      memoizedIds.push(id);
      reasonByRequestedId[id] = 'same_run_memoized';
      continue;
    }
    if (!priorSet.has(id)) {
      admittedIds.push(id);
      reasonByRequestedId[id] = 'current_new';
      continue;
    }
    if (input.historicalRefreshReason === 'necessary_bridge') {
      admittedIds.push(id);
      reasonByRequestedId[id] = 'explicit_necessary_bridge';
      continue;
    }
    if (unattemptedCurrentNew.length === 0) {
      admittedIds.push(id);
      reasonByRequestedId[id] = 'all_history_bypass';
      continue;
    }
    deferredIds.push(id);
    reasonByRequestedId[id] = 'prior_checked_deferred';
  }
  return {
    ok: true, admittedIds, deferredIds, reasonByRequestedId, memoizedIds,
    deferredCount: deferredIds.length,
    priorCheckedCount: priorSet.size,
    historyStatus: usableHistory ? 'active' : 'unavailable',
    historyIgnoredIds,
  };
}
