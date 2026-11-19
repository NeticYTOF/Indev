import { describe, expect, it } from 'vitest';
import { GeocodeSession } from '../src/geocode-session.js';

/**
 * Deterministic deferred-promise regressions for the geocode response
 * ordering race (stale-after-newer / cleared-query / after-pick / stale
 * errors). Arrival order is controlled entirely by when the deferreds
 * resolve - no timers, no real network.
 */

/** Manually-resolved promise: response arrival time is fully controlled. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Mirrors the wired decision in makeSearchField: a response/error is
 * APPLIED only when its session is still current; otherwise it is
 * DISCARDED without touching any list state.
 */
async function arrival<T>(
  session: GeocodeSession,
  token: number,
  response: Promise<T>,
): Promise<T | 'DISCARDED' | 'APPLIED-ERROR'> {
  try {
    const value = await response;
    return session.isCurrent(token) ? value : 'DISCARDED';
  } catch {
    return session.isCurrent(token) ? 'APPLIED-ERROR' : 'DISCARDED';
  }
}

describe('geocode response ordering (stale responses are discarded)', () => {
  it('discards a slower stale response arriving AFTER the newer result', async () => {
    const session = new GeocodeSession();
    const oldToken = session.begin(); // "Delh" dispatched
    const newToken = session.begin(); // "Delhi" dispatched
    const dOld = deferred<string[]>();
    const dNew = deferred<string[]>();
    const outcomeNew = arrival(session, newToken, dNew.promise);
    const outcomeOld = arrival(session, oldToken, dOld.promise);
    // Newer result arrives FIRST; the stale one lands afterwards and
    // must not overwrite the fresh list.
    dNew.resolve(['Delhi, India — fresh']);
    dOld.resolve(['Delh — stale']);
    const results = await Promise.all([outcomeNew, outcomeOld]);
    expect(results[0]).toEqual(['Delhi, India — fresh']); // applied
    expect(results[1]).toBe('DISCARDED'); // out-of-order stale arrival
  });

  it('applies the fresh response when nothing superseded it', async () => {
    const session = new GeocodeSession();
    const token = session.begin();
    const d = deferred<string[]>();
    const outcome = arrival(session, token, d.promise);
    d.resolve(['Jaipur, Rajasthan — fresh']);
    expect(await outcome).toEqual(['Jaipur, Rajasthan — fresh']);
  });

  it('discards a late response for a query the user CLEARED', async () => {
    // Old defect: type "Delhi", backspace to "D" (list hidden+cleared),
    // then the in-flight response lands and REOPENS the stale list.
    const session = new GeocodeSession();
    const token = session.begin();
    const d = deferred<string[]>();
    const outcome = arrival(session, token, d.promise);
    session.invalidate(); // q < 2: the list was cleared and hidden
    d.resolve(['Delhi — stale for the cleared query']);
    expect(await outcome).toBe('DISCARDED');
  });

  it('discards a still-pending same-query response after the user PICKED', async () => {
    // Old defect: pick a suggestion (list hidden), then the pending
    // response repopulates and REOPENS the list over the completed
    // selection.
    const session = new GeocodeSession();
    const token = session.begin();
    const d = deferred<string[]>();
    const outcome = arrival(session, token, d.promise);
    session.invalidate(); // pick
    d.resolve(['Delhi — late, already picked']);
    expect(await outcome).toBe('DISCARDED');
  });

  it('a STALE error never hides the newer list', async () => {
    // Old defect: the catch path unconditionally hid the list, so an
    // older query's error could blank a newer query's results.
    const session = new GeocodeSession();
    const oldToken = session.begin();
    session.begin(); // newer query in flight
    const dOld = deferred<string[]>();
    const outcomeOldError = arrival(session, oldToken, dOld.promise);
    dOld.reject(new Error('boom'));
    expect(await outcomeOldError).toBe('DISCARDED');
  });

  it('a CURRENT error is still applied (hiding the list is legitimate)', async () => {
    const session = new GeocodeSession();
    const token = session.begin();
    const d = deferred<string[]>();
    const outcome = arrival(session, token, d.promise);
    d.reject(new Error('boom'));
    expect(await outcome).toBe('APPLIED-ERROR');
  });

  it('invalidation makes earlier tokens stale; the next dispatch is current', () => {
    const session = new GeocodeSession();
    const t1 = session.begin();
    session.invalidate(); // typing anew / clearing / picking
    const t2 = session.begin(); // the next dispatched query
    expect(session.isCurrent(t1)).toBe(false);
    expect(session.isCurrent(t2)).toBe(true);
  });
});
