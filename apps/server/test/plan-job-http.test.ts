import { describe, expect, it, vi } from 'vitest';
import { createApp, type AppDeps } from '../src/app.js';
import type { Hono } from 'hono';
import { chatCompletion, AiProviderError } from '../src/ai-provider.js';
import type {
  CountersStore, OsrmRouter, PhotonGeocoder, StatiqClient, StatiqMarkersResponse, TripsStore,
} from '@indeev/core';

const ORIGIN = { label: 'Delhi', lat: 28.6139, lon: 77.209 };
const DEST = { label: 'Jaipur', lat: 26.9124, lon: 75.7873 };
const headers = { 'Content-Type': 'application/json' };
const body = JSON.stringify({ origin: ORIGIN, destination: DEST });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const emptyMarkers: StatiqMarkersResponse = {
  ok: true, live: true, retained: false, source: 'test', count: 0, stations: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function depsWith(statiq: StatiqClient, overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    createStatiq: () => statiq,
    router: { route: async () => ({
      distanceKm: 300, durationMin: 300,
      geometry: [{ lat: 28.6, lon: 77.2 }, { lat: 26.9, lon: 75.8 }],
    }) } as unknown as OsrmRouter,
    geocoder: {} as PhotonGeocoder,
    trips: {} as TripsStore,
    counters: {} as CountersStore,
    mock: false,
    ai: { baseUrl: 'https://ai.test/v1', apiKey: 'test-key', model: 'test-model' },
    aiCall: async () => '{"chosenStationIds":[],"notes":"ok"}',
    ...overrides,
  };
}

async function startJob(app: Hono) {
  const res = await app.request('/api/jobs/plan', { method: 'POST', headers, body });
  expect(res.status).toBe(202);
  return await res.json() as { jobId: string; capability: string };
}

describe('process-local job endpoints', () => {
  it('polls with a capability and makes no new provider calls', async () => {
    const gate = deferred<StatiqMarkersResponse>();
    let markerCalls = 0;
    const statiq = {
      markers: async () => { markerCalls += 1; return gate.promise; },
    } as unknown as StatiqClient;
    const app = createApp(depsWith(statiq));
    const job = await startJob(app);
    await tick();
    const baseline = markerCalls;
    for (let i = 0; i < 3; i += 1) {
      const polled = await app.request(`/api/jobs/plan/${job.jobId}`, {
        headers: { 'x-job-capability': job.capability },
      });
      expect(polled.status).toBe(200);
      expect((await polled.json() as { state: string }).state).toBe('running');
    }
    expect(markerCalls).toBe(baseline);
    const cancelled = await app.request(`/api/jobs/plan/${job.jobId}`, {
      method: 'DELETE', headers: { 'x-job-capability': job.capability },
    });
    expect(cancelled.status).toBe(200);
    gate.resolve(emptyMarkers);
    await tick();
  });

  it('refuses overflow and rejects unowned status/cancel', async () => {
    const gate = deferred<StatiqMarkersResponse>();
    const statiq = { markers: async () => gate.promise } as unknown as StatiqClient;
    const app = createApp(depsWith(statiq));
    const first = await startJob(app);
    const second = await app.request('/api/jobs/plan', { method: 'POST', headers, body });
    expect(second.status).toBe(503);
    expect((await second.json() as { code: string }).code).toBe('job_capacity');
    expect((await app.request(`/api/jobs/plan/${first.jobId}`)).status).toBe(404);
    expect((await app.request(`/api/jobs/plan/${first.jobId}`, {
      headers: { 'x-job-capability': 'guess' },
    })).status).toBe(404);
    expect((await app.request(`/api/jobs/plan/${first.jobId}`, {
      method: 'DELETE', headers: { 'x-job-capability': 'guess' },
    })).status).toBe(409);
    gate.resolve(emptyMarkers);
    await tick();
  });

  it('holds one slot across sync and job starts until the run unwinds', async () => {
    const gate = deferred<StatiqMarkersResponse>();
    const statiq = { markers: async () => gate.promise } as unknown as StatiqClient;
    const app = createApp(depsWith(statiq));
    const job = await startJob(app);

    const busyDuringJob = await app.request('/api/plan', { method: 'POST', headers, body });
    expect(busyDuringJob.status).toBe(503);
    expect((await busyDuringJob.json() as { code: string }).code).toBe('run_busy');

    const cancelled = await app.request(`/api/jobs/plan/${job.jobId}`, {
      method: 'DELETE', headers: { 'x-job-capability': job.capability },
    });
    expect(cancelled.status).toBe(200);
    const stillBusy = await app.request('/api/plan', { method: 'POST', headers, body });
    expect(stillBusy.status).toBe(503);

    gate.resolve(emptyMarkers);
    await tick();
    const afterSettle = await app.request('/api/plan', { method: 'POST', headers, body });
    expect(afterSettle.status).not.toBe(503);
  });

  it('rejects wrong browser origins on status and cancel', async () => {
    const gate = deferred<StatiqMarkersResponse>();
    const statiq = { markers: async () => gate.promise } as unknown as StatiqClient;
    const app = createApp(depsWith(statiq));
    const job = await startJob(app);
    const hostile = { Origin: 'https://evil.example', 'x-job-capability': job.capability };
    expect((await app.request(`/api/jobs/plan/${job.jobId}`, { headers: hostile })).status).toBe(403);
    expect((await app.request(`/api/jobs/plan/${job.jobId}`, { method: 'DELETE', headers: hostile })).status).toBe(403);
    gate.resolve(emptyMarkers);
    await tick();
  });

  it('refuses a job while a sync run holds the single slot', async () => {
    const gate = deferred<StatiqMarkersResponse>();
    const statiq = { markers: async () => gate.promise } as unknown as StatiqClient;
    const app = createApp(depsWith(statiq));
    const sync = app.request('/api/plan', { method: 'POST', headers, body });
    await tick();
    const job = await app.request('/api/jobs/plan', { method: 'POST', headers, body });
    expect(job.status).toBe(503);
    expect((await job.json() as { code: string }).code).toBe('job_capacity');
    gate.resolve(emptyMarkers);
    await sync;
  });

  it('AI provider keeps its 45s timeout and cleans up the external abort listener', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, 'addEventListener');
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const fetchImpl = (async (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })) as typeof fetch;
      const pending = chatCompletion({
        baseUrl: 'https://ai.test/v1', apiKey: 'test-key', model: 'test-model', fetchImpl,
      }, [], controller.signal);
      // Attach the rejection handler BEFORE advancing time: the timer fires
      // inside advanceTimersByTimeAsync, and an unobserved rejection there
      // would fail the whole suite with an unhandled rejection.
      const rejected = expect(pending).rejects.toBeInstanceOf(AiProviderError);
      expect(add).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(45_000);
      await rejected;
      expect(remove).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('AI provider aborts the in-flight request on external cancel', async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      observed = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        observed!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }) as typeof fetch;
    const pending = chatCompletion({
      baseUrl: 'https://ai.test/v1', apiKey: 'test-key', model: 'test-model', fetchImpl,
    }, [], controller.signal);
    const rejected = expect(pending).rejects.toBeInstanceOf(AiProviderError);
    await tick();
    expect(observed?.aborted).toBe(false);
    controller.abort();
    expect(observed?.aborted).toBe(true);
    await rejected;
  });

  it('late AI resolution after cancel cannot complete the job', async () => {
    const aiGate = deferred<string>();
    const aiStarted = deferred<void>();
    const statiq = { markers: async () => emptyMarkers } as unknown as StatiqClient;
    const aiCall = async () => { aiStarted.resolve(); return aiGate.promise; };
    const app = createApp(depsWith(statiq, { aiCall }));
    const job = await startJob(app);
    await aiStarted.promise;
    const cancelled = await app.request(`/api/jobs/plan/${job.jobId}`, {
      method: 'DELETE', headers: { 'x-job-capability': job.capability },
    });
    expect(cancelled.status).toBe(200);
    aiGate.resolve('{"chosenStationIds":[],"notes":"late"}');
    await tick();
    const polled = await app.request(`/api/jobs/plan/${job.jobId}`, {
      headers: { 'x-job-capability': job.capability },
    });
    const status = await polled.json() as { state: string; result?: unknown };
    expect(status.state).toBe('cancelled');
    expect(status.result).toBeUndefined();
  });
});
