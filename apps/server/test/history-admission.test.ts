import { describe, expect, it } from 'vitest';
import { admitWithCheckedIdHistory } from '../src/history-admission.js';

const pool = [1000, 1001, 1002, 2000, 2001];
const base = {
  currentPoolIds: pool,
  priorCheckedIds: [1000, 1001],
  currentRunAdmittedIds: [] as number[],
  historyAvailable: true,
};
describe('quota-free checked-ID admission', () => {
  it('defers ordinary prior IDs while unattempted current-new IDs remain', () => {
    const result = admitWithCheckedIdHistory({ ...base, aiRequestedIds: [1000, 2000] });
    expect(result).toMatchObject({ ok: true, admittedIds: [2000], deferredIds: [1000],
      historyStatus: 'active', deferredCount: 1 });
  });

  it('uses explicit necessary-bridge intent without claiming verified necessity', () => {
    const result = admitWithCheckedIdHistory({ ...base, aiRequestedIds: [1000, 2000],
      historicalRefreshReason: 'necessary_bridge' });
    expect(result).toMatchObject({ ok: true, admittedIds: [1000, 2000], deferredIds: [] });
    expect(result.ok && result.reasonByRequestedId[1000]).toBe('explicit_necessary_bridge');
  });

  it('keeps same-run memoization separate from prior history', () => {
    const result = admitWithCheckedIdHistory({ ...base, aiRequestedIds: [1000, 2001],
      currentRunAdmittedIds: [2001] });
    expect(result).toMatchObject({ ok: true, admittedIds: [2001], memoizedIds: [2001], deferredIds: [1000] });
    expect(result.ok && result.reasonByRequestedId[2001]).toBe('same_run_memoized');
  });

  it('auto-bypasses all-history and exhausted-new states', () => {
    const allHistory = admitWithCheckedIdHistory({ ...base,
      currentPoolIds: [1000, 1001], aiRequestedIds: [1000] });
    expect(allHistory).toMatchObject({ ok: true, admittedIds: [1000], deferredIds: [] });
    const exhausted = admitWithCheckedIdHistory({ ...base,
      currentRunAdmittedIds: [1002, 2000, 2001], aiRequestedIds: [1000] });
    expect(exhausted).toMatchObject({ ok: true, admittedIds: [1000], deferredIds: [] });
  });

  it('intersects stale prior IDs without invalidating a valid AI batch', () => {
    const result = admitWithCheckedIdHistory({ ...base,
      priorCheckedIds: [1000, 9999], aiRequestedIds: [1000, 2000] });
    expect(result).toMatchObject({ ok: true, admittedIds: [2000], deferredIds: [1000],
      historyStatus: 'active', historyIgnoredIds: [9999] });
  });

  it('falls back to ordinary admission for malformed or unavailable history', () => {
    const unavailable = admitWithCheckedIdHistory({ ...base,
      historyAvailable: false, priorCheckedIds: [1000, 9999], aiRequestedIds: [1000, 2000] });
    expect(unavailable).toMatchObject({ ok: true, admittedIds: [1000, 2000], deferredIds: [],
      historyStatus: 'unavailable' });
    const malformed = admitWithCheckedIdHistory({ ...base,
      priorCheckedIds: 'bad' as unknown as number[], aiRequestedIds: [1000] });
    expect(malformed).toMatchObject({ ok: true, admittedIds: [1000], deferredIds: [],
      historyStatus: 'unavailable' });
  });

  it.each([
    ['empty', []], ['over five', [1, 2, 3, 4, 5, 6]],
    ['duplicate', [1000, 1000]], ['unknown', [9999]], ['bad id', [0]],
  ])('rejects invalid actual AI batch: %s', (_name, aiRequestedIds) => {
    expect(admitWithCheckedIdHistory({ ...base,
      aiRequestedIds: aiRequestedIds as number[] })).toMatchObject({ ok: false });
  });
});
