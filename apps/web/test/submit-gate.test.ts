import { describe, expect, it } from 'vitest';
import { SubmitGate } from '../src/submit-gate.js';

/**
 * Regression: the shared busy/elapsed readout lifecycle. Old defect (found
 * in independent review): plan and AI runs could overlap; the shared timer
 * was reset by the second start and hidden/cleared by whichever run's
 * finally fired first - while the other was STILL pending. The repair is
 * single flight by construction: a second run cannot begin while the
 * first is in flight, so the overlapping case is unreachable.
 */
describe('planning single-flight gate (busy-readout lifecycle repair)', () => {
  it('refuses a second planning run while the first is still pending', () => {
    const gate = new SubmitGate();
    expect(gate.tryBegin()).toBe(true); // plan run begins
    expect(gate.inFlight()).toBe(true);
    // The other submit path must not start while this run is pending -
    // the old overlap started exactly here.
    expect(gate.tryBegin()).toBe(false); // AI submit refused mid-run
    expect(gate.inFlight()).toBe(true); // first run still owns the readout
    gate.end(); // first run resolves
    expect(gate.inFlight()).toBe(false);
    expect(gate.tryBegin()).toBe(true); // next run may begin
    gate.end();
  });

  it('makes "one resolves while the other is still pending" unreachable', () => {
    const gate = new SubmitGate();
    const began: boolean[] = [];
    // Simulate the old repro shape: two overlapping submit attempts. Only
    // one may begin, so no second run exists to be left pending when the
    // first resolves - the gate cannot be re-opened by the first run's
    // finally either, because end() only releases what tryBegin() won.
    began.push(gate.tryBegin());
    began.push(gate.tryBegin());
    expect(began).toEqual([true, false]);
    gate.end();
    expect(gate.inFlight()).toBe(false);
  });

  it('is reusable across many sequential runs', () => {
    const gate = new SubmitGate();
    for (let i = 0; i < 5; i++) {
      expect(gate.tryBegin()).toBe(true);
      expect(gate.tryBegin()).toBe(false);
      gate.end();
    }
    expect(gate.inFlight()).toBe(false);
  });
});
