import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp, type AppDeps } from '../src/app.js';
import type {
  CountersStore, OsrmRouter, PhotonGeocoder, StatiqClient, StatiqMarkersResponse, TripsStore,
} from '@indeev/core';
import { endpointRouter } from '../../../packages/core/test/support/road-fixture.js';

const ORIGIN = { label: 'Delhi', lat: 28.6139, lon: 77.209 };
const DEST = { label: 'Jaipur', lat: 26.9124, lon: 75.7873 };
const headers = { 'Content-Type': 'application/json' };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const empty: StatiqMarkersResponse = { ok: true, live: true, retained: false, source: 'test', count: 0, stations: [] };

function deps(calls: { markers: number; ai: number }, overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    createStatiq: () => ({ markers: async () => { calls.markers += 1; return empty; } }) as unknown as StatiqClient,
    router: endpointRouter() as unknown as OsrmRouter,
    geocoder: {} as PhotonGeocoder,
    trips: {} as TripsStore,
    counters: { recordPlan: async () => undefined, load: async () => ({ chargersSeen: 0 }) } as unknown as CountersStore,
    mock: false,
    aiToolCall: async () => { calls.ai += 1; throw new Error('AI must not run'); },
    ...overrides,
  };
}

async function terminal(app: Hono, job: { jobId: string; capability: string }) {
  for (let i = 0; i < 400; i += 1) {
    await tick();
    const res = await app.request(`/api/jobs/plan/${job.jobId}`, { headers: { 'x-job-capability': job.capability } });
    const status = await res.json() as { state: string; result?: { plan: { search?: unknown; stops: unknown[] }; ai: { applied: boolean } }; error?: unknown };
    if (status.state !== 'running') return status;
  }
  throw new Error('job never settled');
}

describe('search mode wiring', () => {
  it('sync /api/plan defaults to smart search and reports coverage on the plan', async () => {
    const calls = { markers: 0, ai: 0 };
    const app = createApp(deps(calls));
    const res = await app.request('/api/plan', { method: 'POST', headers,
      body: JSON.stringify({ origin: ORIGIN, destination: DEST, startSocPct: 100 }) });
    expect(res.status).toBe(200);
    const { plan } = await res.json() as { plan: { search: unknown } };
    expect(plan.search).toEqual({ mode: 'smart', candidatesFound: 0, candidatesChecked: 0 });
  });

  it('sync /api/plan honours an explicit thorough search', async () => {
    const app = createApp(deps({ markers: 0, ai: 0 }));
    const res = await app.request('/api/plan', { method: 'POST', headers,
      body: JSON.stringify({ origin: ORIGIN, destination: DEST, searchMode: 'thorough' }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { plan: { search: { mode: string } } }).plan.search.mode).toBe('thorough');
  });

  it.each([['/api/plan'], ['/api/jobs/plan']])('%s rejects an unknown searchMode before any provider call', async (path) => {
    const calls = { markers: 0, ai: 0 };
    const app = createApp(deps(calls, { ai: { baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm' } }));
    const res = await app.request(path, { method: 'POST', headers,
      body: JSON.stringify({ origin: ORIGIN, destination: DEST, searchMode: 'everything' }) });
    expect(res.status).toBe(400);
    expect(calls.markers).toBe(0);
  });

  it('rejects an unknown job engine', async () => {
    const app = createApp(deps({ markers: 0, ai: 0 }));
    const res = await app.request('/api/jobs/plan', { method: 'POST', headers,
      body: JSON.stringify({ origin: ORIGIN, destination: DEST, engine: 'gpu' }) });
    expect(res.status).toBe(400);
  });

  it('runs a rules-only thorough job without an AI provider configured', async () => {
    const calls = { markers: 0, ai: 0 };
    const app = createApp(deps(calls));
    const start = await app.request('/api/jobs/plan', { method: 'POST', headers,
      body: JSON.stringify({ origin: ORIGIN, destination: DEST, engine: 'planner' }) });
    expect(start.status).toBe(202);
    const status = await terminal(app, await start.json() as { jobId: string; capability: string });
    expect(status.state).toBe('succeeded');
    expect(status.result?.plan.search).toMatchObject({ mode: 'thorough' });
    expect(status.result?.ai.applied).toBe(false);
    expect(calls.ai).toBe(0);
    expect(calls.markers).toBeGreaterThan(0);
  });

  it('still refuses AI jobs when no AI provider is configured', async () => {
    const app = createApp(deps({ markers: 0, ai: 0 }));
    const res = await app.request('/api/jobs/plan', { method: 'POST', headers,
      body: JSON.stringify({ origin: ORIGIN, destination: DEST }) });
    expect(res.status).toBe(503);
  });
});
