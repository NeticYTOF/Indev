import { describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { planTrip } from '../src/planner.js';
import { StatiqClient } from '../src/statiq.js';
import { OsrmRouter, RouterError } from '../src/router.js';

function osrmOk() {
  return {
    status: 200,
    body: JSON.stringify({
      code: 'Ok',
      routes: [
        {
          distance: 284_900,
          duration: 13_000,
          geometry: { coordinates: [[77.209, 28.6139], [76.5, 27.8], [75.7873, 26.9124]] },
        },
      ],
    }),
  };
}

function fakeFetch(responder: () => { status: number; body: string }, latency?: { impl?: typeof fetch; calls: string[] }) {
  const calls: string[] = latency?.calls ?? [];
  const impl = (async (url: unknown) => {
    calls.push(String(url));
    const { status, body } = responder();
    return new Response(body, { status });
  }) as typeof fetch;
  return { impl, calls };
}

describe('OsrmRouter', () => {
  it.each([
    { geometry: { coordinates: [] } },
    { geometry: { coordinates: [[77, 28]] } },
    { geometry: { coordinates: [null, [77, 28]] } },
    { geometry: { coordinates: [[77, 91], [77, 28]] } },
    { geometry: { coordinates: [['77', 28], [77, 28]] } },
    { geometry: null }, { distance: -1 }, { duration: -1 }, { distance: null },
  ])('rejects a malformed successful route: %j', async (override) => {
    const original = JSON.parse(osrmOk().body);
    original.routes[0] = { ...original.routes[0], ...override };
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: JSON.stringify(original) }));
    const router = new OsrmRouter({ fetchImpl: impl, retries: 0 });
    await expect(router.route({ lat: 28, lon: 77 }, { lat: 27, lon: 76 })).rejects.toMatchObject({
      name: 'RouterError', code: 'InvalidResponse',
    });
    expect(calls).toHaveLength(1);
  });

  it('parses route distance, duration and geometry', async () => {
    const { impl, calls } = fakeFetch(osrmOk);
    const router = new OsrmRouter({ baseUrl: 'https://router.test', fetchImpl: impl });
    const r = await router.route({ lat: 28.6139, lon: 77.209 }, { lat: 26.9124, lon: 75.7873 });
    expect(r.distanceKm).toBeCloseTo(284.9, 1);
    expect(r.durationMin).toBeCloseTo(216.7, 1);
    expect(r.geometry).toEqual([
      { lat: 28.6139, lon: 77.209 },
      { lat: 27.8, lon: 76.5 },
      { lat: 26.9124, lon: 75.7873 },
    ]);
    expect(calls[0]).toContain('/route/v1/driving/77.209000,28.613900;75.787300,26.912400');
    expect(calls[0]).toContain('overview=full');
  });

  it('throws RouterError when OSRM cannot find a route', async () => {
    const { impl } = fakeFetch(() => ({
      status: 200,
      body: JSON.stringify({ code: 'NoRoute', message: 'No route found' }),
    }));
    const router = new OsrmRouter({ baseUrl: 'https://router.test', fetchImpl: impl });
    await expect(router.route({ lat: 1, lon: 1 }, { lat: 2, lon: 2 })).rejects.toBeInstanceOf(RouterError);
  });

  it('retries then succeeds on transient HTTP errors', async () => {
    let n = 0;
    const calls: string[] = [];
    const impl = (async (url: unknown) => {
      calls.push(String(url));
      n++;
      const ok = n >= 2 ? osrmOk() : { status: 500, body: 'oops' };
      return new Response(ok.body, { status: ok.status });
    }) as typeof fetch;
    const router = new OsrmRouter({ baseUrl: 'https://router.test', fetchImpl: impl });
    const r = await router.route({ lat: 1, lon: 1 }, { lat: 2, lon: 2 });
    expect(r.distanceKm).toBeCloseTo(284.9, 1);
    expect(calls).toHaveLength(2);
  });
});

// These fetches never touch a network. Each transport cooperatively observes
// its own request signal, or deliberately ignores it for the late-response case.
const origin = { lat: 1, lon: 1 }, destination = { lat: 2, lon: 2 };
function abortableFetch(counter: { attempts: number; aborted: number }): typeof fetch {
  return (async (_url, init) => {
    counter.attempts++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        counter.aborted++; reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }) as typeof fetch;
}

it('does not dispatch a preaborted route', async () => {
  const outer = new AbortController(); outer.abort(); const counter = { attempts: 0, aborted: 0 };
  const router = new OsrmRouter({ fetchImpl: abortableFetch(counter) });
  await expect(router.route(origin, destination, outer.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(counter.attempts).toBe(0);
});

it('cancels active routing fetch without retry and removes its outer listener', async () => {
  const outer = new AbortController(); const counter = { attempts: 0, aborted: 0 };
  const router = new OsrmRouter({ fetchImpl: abortableFetch(counter), retries: 2, timeoutMs: 1000 });
  const pending = router.route(origin, destination, outer.signal);
  setTimeout(() => outer.abort(), 10);
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(counter).toEqual({ attempts: 1, aborted: 1 });
  expect(getEventListeners(outer.signal, 'abort')).toHaveLength(0);
});

it('cancels response-body reading and does not retry it after outer abort', async () => {
  const outer = new AbortController(); let attempts = 0, bodyAborted = false;
  const fetchImpl = (async (_url, init) => {
    attempts++;
    return { ok: true, json: () => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { bodyAborted = true; reject(new DOMException('Aborted', 'AbortError')); });
      setTimeout(() => outer.abort(), 10);
    }) } as unknown as Response;
  }) as typeof fetch;
  const router = new OsrmRouter({ fetchImpl, retries: 2 });
  await expect(router.route(origin, destination, outer.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(attempts).toBe(1); expect(bodyAborted).toBe(true);
  expect(getEventListeners(outer.signal, 'abort')).toHaveLength(0);
});

it('cancels retry backoff without a second dispatch', async () => {
  const outer = new AbortController(); let attempts = 0;
  const fetchImpl = (async () => { attempts++; setTimeout(() => outer.abort(), 10); return new Response('no route', { status: 503 }); }) as typeof fetch;
  const router = new OsrmRouter({ fetchImpl, retries: 2 });
  await expect(router.route(origin, destination, outer.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(attempts).toBe(1); expect(getEventListeners(outer.signal, 'abort')).toHaveLength(0);
});

it('still retries a per-request timeout while the outer run remains alive', async () => {
  const outer = new AbortController(); let attempts = 0;
  const fetchImpl = (async (_url, init) => {
    attempts++;
    if (attempts === 1) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Timeout', 'AbortError'))));
    return new Response(osrmOk().body, { status: 200 });
  }) as typeof fetch;
  const router = new OsrmRouter({ fetchImpl, timeoutMs: 10, retries: 1 });
  expect((await router.route(origin, destination, outer.signal)).distanceKm).toBe(284.9);
  expect(attempts).toBe(2); expect(outer.signal.aborted).toBe(false);
  expect(getEventListeners(outer.signal, 'abort')).toHaveLength(0);
});

it.each(['fetch', 'body'] as const)('refuses late noncooperative %s success after outer abort', async phase => {
  const outer = new AbortController(); let attempts = 0;
  const fetchImpl = (async () => {
    attempts++;
    const late = async () => { await new Promise(resolve => setTimeout(resolve, 25)); return JSON.parse(osrmOk().body); };
    setTimeout(() => outer.abort(), 5);
    if (phase === 'fetch') { await late(); return new Response(osrmOk().body); }
    return { ok: true, json: late } as unknown as Response;
  }) as typeof fetch;
  const router = new OsrmRouter({ fetchImpl, retries: 2 });
  await expect(router.route(origin, destination, outer.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(attempts).toBe(1); expect(getEventListeners(outer.signal, 'abort')).toHaveLength(0);
});

it('keeps simultaneous route cancellation signals independent', async () => {
  const one = new AbortController(), two = new AbortController(); let attempts = 0;
  const fetchImpl = (async (_url, init) => new Promise<Response>((resolve, reject) => {
    attempts++; const timer = setTimeout(() => resolve(new Response(osrmOk().body)), 30);
    init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); });
  })) as typeof fetch;
  const router = new OsrmRouter({ fetchImpl });
  const aborted = router.route(origin, destination, one.signal), successful = router.route(origin, destination, two.signal);
  setTimeout(() => one.abort(), 5);
  await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
  expect((await successful).distanceKm).toBe(284.9); expect(attempts).toBe(2); expect(two.signal.aborted).toBe(false);
  expect(getEventListeners(one.signal, 'abort')).toHaveLength(0); expect(getEventListeners(two.signal, 'abort')).toHaveLength(0);
});

it('planner deadline cancels routing and reports no-verdict without a Statiq attempt', async () => {
  const counter = { attempts: 0, aborted: 0 }; let stationAttempts = 0;
  const router = new OsrmRouter({ fetchImpl: abortableFetch(counter), retries: 2, timeoutMs: 2000 });
  const statiq = new StatiqClient({ token: 'offline-fixture', fetchImpl: (async () => { stationAttempts++; throw new Error('unexpected synthetic dispatch'); }) as typeof fetch });
  await expect(planTrip({ router, statiq }, { ...origin, label: 'A' }, { ...destination, label: 'B' }, { runBudget: { deadlineMs: 50, maxUpstreamCalls: 100 } })).rejects.toMatchObject({ code: 'not_determined', cause: 'deadline' });
  expect(counter).toEqual({ attempts: 1, aborted: 1 }); expect(stationAttempts).toBe(0);
});


it.each(['success', 'fetch error', 'body error'] as const)('cleans owned timeout and outer listener after %s', async outcome => {
  vi.useFakeTimers();
  try {
    const outer = new AbortController();
    const fetchImpl = (async () => {
      if (outcome === 'fetch error') throw new Error('synthetic fetch failure');
      if (outcome === 'body error') return { ok: true, json: async () => { throw new Error('synthetic body failure'); } } as unknown as Response;
      return new Response(osrmOk().body);
    }) as typeof fetch;
    const router = new OsrmRouter({ fetchImpl, retries: 0, timeoutMs: 1000 });
    const pending = router.route(origin, destination, outer.signal);
    if (outcome === 'success') expect((await pending).distanceKm).toBe(284.9);
    else await expect(pending).rejects.toThrow('synthetic');
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(outer.signal, 'abort')).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

const okGeometry = [
  { lat: 28.6139, lon: 77.209 },
  { lat: 27.8, lon: 76.5 },
  { lat: 26.9124, lon: 75.7873 },
];

it.each([
  { name: 'one', via: [{ lat: 1.5, lon: 1.5 }], url: 'https://router.test/route/v1/driving/1.000000,1.000000;1.500000,1.500000;2.000000,2.000000?overview=full&geometries=geojson' },
  { name: 'five', via: [
    { lat: 1.1, lon: 1.1 }, { lat: 1.2, lon: 1.2 }, { lat: 1.3, lon: 1.3 }, { lat: 1.4, lon: 1.4 }, { lat: 1.5, lon: 1.5 },
  ], url: 'https://router.test/route/v1/driving/1.000000,1.000000;1.100000,1.100000;1.200000,1.200000;1.300000,1.300000;1.400000,1.400000;1.500000,1.500000;2.000000,2.000000?overview=full&geometries=geojson' },
])('routes through $name ordered via point(s) in one OSRM request', async ({ via, url }) => {
  const { impl, calls } = fakeFetch(osrmOk);
  const router = new OsrmRouter({ baseUrl: 'https://router.test', fetchImpl: impl });
  const result = await router.route(origin, destination, undefined, via);
  expect(calls).toEqual([url]);
  expect(result.geometry).toEqual(okGeometry);
  expect(result.distanceKm).toBeCloseTo(284.9, 1);
});

it.each([
  ['six', Array.from({ length: 6 }, (_, i) => ({ lat: 1 + i / 10, lon: 1 + i / 10 }))],
  ['NaN', [{ lat: Number.NaN, lon: 1 }]],
  ['out of range', [{ lat: 91, lon: 1 }]],
] as const)('rejects %s via points before dispatch', async (_name, via) => {
  const { impl, calls } = fakeFetch(osrmOk);
  const router = new OsrmRouter({ baseUrl: 'https://router.test', fetchImpl: impl });
  await expect(router.route(origin, destination, undefined, via)).rejects.toMatchObject({ name: 'RouterError', code: 'InvalidWaypoints' });
  expect(calls).toHaveLength(0);
});

it('does not dispatch a preaborted route with via', async () => {
  const outer = new AbortController(); outer.abort();
  const counter = { attempts: 0, aborted: 0 };
  const router = new OsrmRouter({ fetchImpl: abortableFetch(counter) });
  await expect(router.route(origin, destination, outer.signal, [{ lat: 1.5, lon: 1.5 }])).rejects.toMatchObject({ name: 'AbortError' });
  expect(counter.attempts).toBe(0);
});
