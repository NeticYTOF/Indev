import { expect, it } from 'vitest';
import { planTrip } from '../src/planner.js';
import { OsrmRouter } from '../src/router.js';
import { getEventListeners } from 'node:events';
import { StatiqAbortError, StatiqClient, StatiqRunFatalError, type UpstreamAuditEntry } from '../src/statiq.js';
import { UpstreamBudget, UpstreamRunStoppedError } from '../src/upstream-budget.js';

const markers = { ok: true, stations: [], count: 0 };
const details = { ok: true, station: { stationId: 1 } };
const fast = { minCallGapMs: 1, maxCallsPerMinute: 1000, retries: 0 };

it('abort between paced permit and continuation reserves, dispatches and audits zero', async () => {
  const outer = new AbortController(), budget = new UpstreamBudget(5);
  let requests = 0; const audit: UpstreamAuditEntry[] = [];
  const client = new StatiqClient({ token: 'offline-only', ...fast,
    now: () => { queueMicrotask(() => outer.abort()); return Date.now(); },
    fetchImpl: (async () => { requests++; return new Response(JSON.stringify(markers)); }) as typeof fetch,
    onUpstreamCall: entry => audit.push(entry),
  });
  client.attachRunBudget(budget);
  await expect(client.markers(0, 0, outer.signal)).rejects.toBeInstanceOf(StatiqAbortError);
  expect(requests).toBe(0); expect(budget.attemptsMade).toBe(0); expect(audit).toHaveLength(0);
});

it.each(['fetch', 'body'] as const)('refuses noncooperative late %s success with one header audit and no retry', async phase => {
  const outer = new AbortController(), budget = new UpstreamBudget(5);
  let requests = 0, bodyReads = 0; const audit: UpstreamAuditEntry[] = [];
  const client = new StatiqClient({ token: 'offline-only', ...fast, retries: 2,
    fetchImpl: (async () => {
      requests++;
      if (phase === 'fetch') { outer.abort(); await Promise.resolve(); }
      return { ok: true, status: 200, text: async () => {
        bodyReads++;
        if (phase === 'body') { outer.abort(); await Promise.resolve(); }
        return JSON.stringify(markers);
      } } as Response;
    }) as typeof fetch,
    onUpstreamCall: entry => audit.push(entry),
  });
  client.attachRunBudget(budget);
  await expect(client.markers(0, 0, outer.signal)).rejects.toBeInstanceOf(StatiqAbortError);
  expect(requests).toBe(1); expect(budget.attemptsMade).toBe(1);
  expect(audit.map(entry => entry.status)).toEqual([200]);
  expect(bodyReads).toBe(phase === 'fetch' ? 0 : 1);
  expect(getEventListeners(outer.signal, 'abort')).toHaveLength(0);
});

it.each([401, 403, 429].flatMap(status => ['fetch', 'body', 'body rejection'].map(phase => ({ status, phase }))))('fatal $status headers beat $phase abort, stop concurrent dispatch and audit once', async ({ status, phase }) => {
  const outer = new AbortController(), budget = new UpstreamBudget(5);
  const audit: UpstreamAuditEntry[] = []; let requests = 0, bodyReads = 0, release!: () => void;
  const headerGate = new Promise<void>(resolve => { release = resolve; });
  const client = new StatiqClient({ token: 'offline-only', ...fast,
    sleepImpl: async () => { await headerGate; },
    fetchImpl: (async () => {
      requests++; if (phase === 'fetch') outer.abort(); release();
      return { ok: false, status, headers: new Headers({ 'Retry-After': '30' }),
        text: async () => { bodyReads++; outer.abort(); if (phase === 'body rejection') throw new DOMException('Aborted', 'AbortError'); return 'fatal fixture'; } } as Response;
    }) as typeof fetch,
    onUpstreamCall: entry => audit.push(entry),
  });
  client.attachRunBudget(budget);
  const results = await Promise.allSettled([client.markers(0, 0, outer.signal), client.markers(1, 1)]);
  expect(results[0].status).toBe('rejected'); expect(results[1].status).toBe('rejected');
  if (results[0].status !== 'rejected' || results[1].status !== 'rejected') throw new Error('both calls must reject');
  expect(results[0].reason).toBeInstanceOf(StatiqRunFatalError);
  expect(results[0].reason.status).toBe(status);
  expect(results[1].reason).toBeInstanceOf(UpstreamRunStoppedError);
  expect(budget.stopped).toBe(status === 429 ? 'throttled' : 'auth');
  if (status === 429) expect(budget.retryAfterMs).toBe(30000);
  expect(budget.attemptsMade).toBe(1); expect(requests).toBe(1); expect(bodyReads).toBe(phase === 'fetch' ? 0 : 1);
  expect(audit.map(entry => entry.status)).toEqual([status]);
});

it('preaborted memo lookup cannot return cached details or dispatch', async () => {
  let requests = 0;
  const client = new StatiqClient({ token: 'offline-only', ...fast, fetchImpl: (async () => {
    requests++; return new Response(JSON.stringify(details));
  }) as typeof fetch });
  await client.detailsWithMeta(1);
  const outer = new AbortController(); outer.abort();
  await expect(client.detailsWithMeta(1, outer.signal)).rejects.toBeInstanceOf(StatiqAbortError);
  await expect(client.details(1, outer.signal)).rejects.toBeInstanceOf(StatiqAbortError);
  expect(requests).toBe(1);
});

it('wire-shaped details wrapper rechecks cancellation after memo metadata await', async () => {
  let requests = 0;
  const client = new StatiqClient({ token: 'offline-only', ...fast, fetchImpl: (async () => {
    requests++; return new Response(JSON.stringify(details));
  }) as typeof fetch });
  await client.details(1);
  const outer = new AbortController();
  const pending = client.details(1, outer.signal); outer.abort();
  await expect(pending).rejects.toBeInstanceOf(StatiqAbortError);
  expect(requests).toBe(1);
});

it.each(['fetch', 'body'] as const)('does not cache details from a cancelled late %s result', async phase => {
  const outer = new AbortController(); let requests = 0;
  const client = new StatiqClient({ token: 'offline-only', ...fast, fetchImpl: (async () => {
    requests++;
    if (requests === 1 && phase === 'fetch') outer.abort();
    return { ok: true, status: 200, text: async () => {
      if (requests === 1 && phase === 'body') outer.abort();
      return JSON.stringify(details);
    } } as Response;
  }) as typeof fetch });
  await expect(client.detailsWithMeta(1, outer.signal)).rejects.toBeInstanceOf(StatiqAbortError);
  await expect(client.detailsWithMeta(1)).resolves.toMatchObject({ response: details });
  expect(requests).toBe(2);
});


it.each(['marker', 'details'] as const)('planner refuses late %s success instead of counting it as fresh coverage', async phase => {
  let detailRequests = 0;
  const router = new OsrmRouter({ fetchImpl: (async () => new Response(JSON.stringify({ code: 'Ok', routes: [{ distance: 111, duration: 10, geometry: { coordinates: [[0, 0], [0.001, 0]] } }] }))) as typeof fetch });
  const client = new StatiqClient({ token: 'offline-only', ...fast, minCallGapMs: 0, fetchImpl: (async url => {
    if (String(url).endsWith('/stations/markers')) {
      if (phase === 'marker') await new Promise(resolve => setTimeout(resolve, 75));
      return new Response(JSON.stringify({ ok: true, stations: [{ stationId: 1, name: 'Fixture', lat: 0, lon: 0.0005 }] }));
    }
    detailRequests++;
    return { ok: true, status: 200, text: async () => {
      if (detailRequests === 1) await new Promise(resolve => setTimeout(resolve, 75));
      return JSON.stringify({ ok: true, station: { stationId: 1, chargers: [] } });
    } } as Response;
  }) as typeof fetch });
  await expect(planTrip({ router, statiq: client }, { label: 'A', lat: 0, lon: 0 }, { label: 'B', lat: 0, lon: 0.001 }, { runBudget: { deadlineMs: 50, maxUpstreamCalls: 100 } })).rejects.toMatchObject({ code: 'not_determined', cause: 'deadline', message: expect.stringContaining(phase === 'marker' ? 'route samples covered 0/0 of 2 planned' : 'candidates processed 0/1') });
  if (phase === 'marker') expect(detailRequests).toBe(0);
  else {
    await client.detailsWithMeta(1);
    expect(detailRequests).toBe(2);
  }
});
