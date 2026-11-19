import { describe, expect, it } from 'vitest';
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
