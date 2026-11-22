import { describe, expect, it } from 'vitest';
import { SelectiveToolLedger, SELECTIVE_TOOL_BUDGETS } from '../src/selective-tools.js';

describe('selective ledger deferral', () => {
  it('preserves baseline accounting when deferral is disabled', () => {
    const ledger = new SelectiveToolLedger(new Set([1, 2]), SELECTIVE_TOOL_BUDGETS.standard20);
    expect(ledger.admit({ ids: [1, 2] })).toMatchObject({ ids: [1, 2], newIds: [1, 2],
      memoIds: [], deferredIds: [] });
    expect(ledger.admit({ ids: [2, 1] })).toMatchObject({ ids: [2, 1], memoIds: [2, 1] });
    expect(ledger.admission).toEqual({ attemptedCalls: 2, admittedCalls: 2, rejectedCalls: 0,
      rejectedByReason: { aborted: 0, call_cap: 0, invalid_shape: 0, invalid_id: 0,
        duplicate_id: 0, unknown_id: 0, total_cap: 0 },
      requestedIds: 4, newIds: 2, memoIds: 2 });
    expect(ledger.deferral).toEqual({ requestedIds: 0, deferredIds: 0, calls: 0 });
  });

  it('reserves only admitted IDs while counting deferred requests and the call', () => {
    const ledger = new SelectiveToolLedger(new Set([1, 2, 3]), SELECTIVE_TOOL_BUDGETS.standard20);
    const result = ledger.admit({ ids: [1, 2, 3] },
      undefined, new Set([1, 2]));
    expect(result).toMatchObject({ ids: [3], newIds: [3], memoIds: [], deferredIds: [1, 2] });
    expect(ledger.admitted.has(1)).toBe(false);
    expect(ledger.deferral).toEqual({ requestedIds: 3, deferredIds: 2, calls: 1 });
    expect(ledger.calls).toBe(1);
    expect(ledger.admission.admittedCalls).toBe(1);
  });

  it('rejects malformed refresh intent and invalid AI shapes before deferral', () => {
    const ledger = new SelectiveToolLedger(new Set([1]), SELECTIVE_TOOL_BUDGETS.standard20);
    expect(ledger.admit({ ids: [1], historicalRefreshReason: 'unknown' })).toBeNull();
    expect(ledger.admit({ ids: [1, 1] })).toBeNull();
    expect(ledger.admit({ ids: [1, 2] })).toBeNull();
    expect(ledger.admit({ ids: [1, 2, 3, 4, 5, 6] })).toBeNull();
    expect(ledger.deferral.deferredIds).toBe(0);
    expect(ledger.admission.rejectedByReason.invalid_shape).toBe(2);
    expect(ledger.admission.rejectedByReason.duplicate_id).toBe(1);
    expect(ledger.admission.rejectedByReason.unknown_id).toBe(1);
  });
});
