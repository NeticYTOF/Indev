import { expect, it } from 'vitest';
import { pMap } from '../src/utils.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('joins active workers, stops claiming new items and preserves the first thrown value', async () => {
  const fail = gate(), sibling = gate(); const started: number[] = [], finished: number[] = [];
  const error = new Error('first failure'); let settled = false;
  const result = pMap([0, 1, 2, 3], 2, async value => {
    started.push(value);
    if (value === 0) { await fail.promise; throw error; }
    await sibling.promise; finished.push(value); return value;
  }).catch(err => { settled = true; return err; });
  fail.resolve(); await new Promise(resolve => setImmediate(resolve));
  expect(settled).toBe(false); expect(started).toEqual([0, 1]);
  sibling.resolve(); expect(await result).toBe(error);
  expect(finished).toEqual([1]); expect(started).toEqual([0, 1]);
});

it('observes subsequent worker failures without replacing the first or escaping unhandled', async () => {
  const first = gate(), second = gate();
  const pending = pMap([0, 1, 2], 2, async value => {
    await (value === 0 ? first : second).promise;
    throw value === 0 ? undefined : new Error('later');
  });
  const outcome = pending.catch(error => ({ error }));
  first.resolve(); await new Promise(resolve => setImmediate(resolve)); second.resolve();
  expect(await outcome).toEqual({ error: undefined });
});

it('does all work exactly once at bounded concurrency and keeps input result order', async () => {
  let active = 0, peak = 0; const seen: number[] = [];
  const results = await pMap([0, 1, 2, 3, 4, 5], 3, async value => {
    seen.push(value); peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 6 - value)); active--;
    return value * 2;
  });
  expect(results).toEqual([0, 2, 4, 6, 8, 10]); expect(seen.sort()).toEqual([0, 1, 2, 3, 4, 5]); expect(peak).toBe(3);
});

it.each(['marker', 'details'].flatMap(stage => ['headers', 'body'].map(phase => ({ stage, phase }))))('planner joins $stage fatal-run sibling $phase and freezes final evidence before returning', async ({ stage, phase }) => {
  const { planTrip, OsrmRouter, StatiqClient } = await import('../src/index.js');
  const fatal = gate(), siblings = gate(), allStarted = gate();
  let requests = 0, settledSiblings = 0, audits = 0, returned = false;
  const router = new OsrmRouter({ fetchImpl: (async () => new Response(JSON.stringify({ code: 'Ok', routes: [{ distance: 30000, duration: 1000, geometry: { coordinates: [[0, 0], [0.27, 0]] } }] }))) as typeof fetch });
  const client = new StatiqClient({ token: 'offline-only', minCallGapMs: 0, maxCallsPerMinute: 1000, retries: 0,
    fetchImpl: (async url => {
      if (stage === 'details' && String(url).endsWith('/markers')) return new Response(JSON.stringify({ ok: true, stations: [1, 2, 3, 4].map(id => ({ stationId: id, name: 'Fixture', lat: 0, lon: id * 0.05 })) }));
      const n = ++requests; if (requests === 4) allStarted.resolve();
      if (n === 1) { await fatal.promise; return new Response('fixture', { status: 429, headers: { 'retry-after': '30' } }); }
      if (phase === 'headers') await siblings.promise;
      return { ok: true, status: 200, text: async () => {
        if (phase === 'body') await siblings.promise;
        settledSiblings++; return JSON.stringify({ ok: true, stations: [] });
      } } as Response;
    }) as typeof fetch,
    onUpstreamCall: () => { audits++; },
  });
  const pending = planTrip({ router, statiq: client }, { label: 'A', lat: 0, lon: 0 }, { label: 'B', lat: 0, lon: 0.27 }).catch(error => { returned = true; return error; });
  await allStarted.promise; fatal.resolve(); await new Promise(resolve => setImmediate(resolve));
  expect(returned).toBe(false); expect(settledSiblings).toBe(0);
  siblings.resolve();
  expect(await pending).toMatchObject({ code: 'not_determined', cause: 'throttled' });
  expect(settledSiblings).toBe(3); expect(audits).toBe(stage === 'marker' ? 4 : 8); expect(requests).toBe(4);
  const finalAudits = audits;
  await new Promise(resolve => setImmediate(resolve));
  expect(audits).toBe(finalAudits); expect(settledSiblings).toBe(3);
});

it('deadline still promptly cancels and joins every cooperative active worker', async () => {
  const { planTrip, OsrmRouter, StatiqClient } = await import('../src/index.js');
  let requests = 0, settled = 0;
  const router = new OsrmRouter({ fetchImpl: (async () => new Response(JSON.stringify({ code: 'Ok', routes: [{ distance: 30000, duration: 1000, geometry: { coordinates: [[0, 0], [0.27, 0]] } }] }))) as typeof fetch });
  const client = new StatiqClient({ token: 'offline-only', minCallGapMs: 0, maxCallsPerMinute: 1000, retries: 0,
    fetchImpl: (async (_url, init) => {
      requests++;
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => { settled++; reject(new DOMException('Aborted', 'AbortError')); }, { once: true }));
    }) as typeof fetch,
  });
  const start = performance.now();
  await expect(planTrip({ router, statiq: client }, { label: 'A', lat: 0, lon: 0 }, { label: 'B', lat: 0, lon: 0.27 }, { runBudget: { deadlineMs: 50, maxUpstreamCalls: 100 } })).rejects.toMatchObject({ code: 'not_determined', cause: 'deadline' });
  expect(settled).toBe(4); expect(requests).toBe(4); expect(performance.now() - start).toBeLessThan(500);
});

it.each(['marker', 'details'] as const)('cap refusal in %s joins reserved work without cancelling it or mutating after return', async phase => {
  const { planTrip, OsrmRouter, StatiqClient } = await import('../src/index.js');
  const pendingWork = gate(), allStarted = gate();
  let phaseRequests = 0, aborts = 0, finished = 0, audits = 0, returned = false;
  const router = new OsrmRouter({ fetchImpl: (async () => new Response(JSON.stringify({ code: 'Ok', routes: [{ distance: 30000, duration: 1000, geometry: { coordinates: [[0, 0], [0.27, 0]] } }] }))) as typeof fetch });
  const stations = [1, 2, 3, 4].map(id => ({ stationId: id, name: 'Fixture', lat: 0, lon: id * 0.05 }));
  const client = new StatiqClient({ token: 'offline-only', minCallGapMs: 0, maxCallsPerMinute: 1000, retries: 0,
    fetchImpl: (async (url, init) => {
      const isMarker = String(url).endsWith('/markers');
      if (phase === 'details' && isMarker) return new Response(JSON.stringify({ ok: true, stations }));
      if (++phaseRequests === 2) allStarted.resolve();
      init?.signal?.addEventListener('abort', () => { aborts++; }, { once: true });
      await pendingWork.promise; finished++;
      return new Response(JSON.stringify(isMarker ? { ok: true, stations: [] } : { ok: true, station: null }));
    }) as typeof fetch,
    onUpstreamCall: () => { audits++; },
  });
  const pending = planTrip({ router, statiq: client }, { label: 'A', lat: 0, lon: 0 }, { label: 'B', lat: 0, lon: 0.27 }, { runBudget: { deadlineMs: 2000, maxUpstreamCalls: phase === 'marker' ? 2 : 6 } }).catch(error => { returned = true; return error; });
  await allStarted.promise; await new Promise(resolve => setImmediate(resolve));
  expect(returned).toBe(false); expect(aborts).toBe(0);
  pendingWork.resolve();
  expect(await pending).toMatchObject({ code: 'not_determined', cause: 'budget-exhausted' });
  expect(finished).toBe(2); expect(phaseRequests).toBe(2);
  const final = { finished, audits, phaseRequests };
  await new Promise(resolve => setImmediate(resolve));
  expect({ finished, audits, phaseRequests }).toEqual(final);
});

it('deadline remains armed during cap-error drain and does not overwrite the first cap refusal', async () => {
  const { planTrip, OsrmRouter, StatiqClient } = await import('../src/index.js');
  let requests = 0, settled = 0;
  const router = new OsrmRouter({ fetchImpl: (async () => new Response(JSON.stringify({ code: 'Ok', routes: [{ distance: 30000, duration: 1000, geometry: { coordinates: [[0, 0], [0.27, 0]] } }] }))) as typeof fetch });
  const client = new StatiqClient({ token: 'offline-only', minCallGapMs: 0, maxCallsPerMinute: 1000, retries: 0,
    fetchImpl: (async (_url, init) => {
      requests++;
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => { settled++; reject(new DOMException('Aborted', 'AbortError')); }, { once: true }));
    }) as typeof fetch,
  });
  await expect(planTrip({ router, statiq: client }, { label: 'A', lat: 0, lon: 0 }, { label: 'B', lat: 0, lon: 0.27 }, { runBudget: { deadlineMs: 50, maxUpstreamCalls: 2 } })).rejects.toMatchObject({ code: 'not_determined', cause: 'budget-exhausted' });
  expect(settled).toBe(2); expect(requests).toBe(2);
});
