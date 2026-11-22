import { describe, expect, it, vi } from 'vitest';
import { createApp, type AppDeps } from '../src/app.js';
import type { Hono } from 'hono';
import { toolFixture } from './ai-tool-fixture.js';
import { chatCompletion, AiProviderError } from '../src/ai-provider.js';
import type {
  CountersStore, OsrmRouter, PhotonGeocoder, StatiqClient, StatiqMarkersResponse, TripsStore,
} from '@indeev/core';
import { endpointRouter } from '../../../packages/core/test/support/road-fixture.js';

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


async function waitTerminal(
  app: Hono,
  job: { jobId: string; capability: string },
  expected: 'succeeded' | 'failed',
): Promise<Response> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await tick();
    const res = await app.request(`/api/jobs/plan/${job.jobId}`, {
      headers: { 'x-job-capability': job.capability },
    });
    const snapshot = res.clone();
    const state = await res.json() as { state: string };
    if (state.state !== 'queued' && state.state !== 'running') {
      expect(state.state).toBe(expected);
      return snapshot;
    }
  }
  throw new Error(`job did not reach ${expected}`);
}
function depsWith(statiq: StatiqClient, overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    createStatiq: () => statiq,
    router: endpointRouter() as unknown as OsrmRouter,
    geocoder: {} as PhotonGeocoder,
    trips: {} as TripsStore,
    counters: {} as CountersStore,
    mock: false,
    ai: { baseUrl: 'https://ai.test/v1', apiKey: 'test-key', model: 'test-model' },
    aiToolCall: toolFixture('{"chosenStationIds":[],"notes":"ok"}', []),
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
    const aiToolCall = async () => {
      aiStarted.resolve();
      return { content: await aiGate.promise, toolCalls: [] };
    };
    const app = createApp(depsWith(statiq, { aiToolCall }));
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

  it('failed job exposes error evidence but never its capability', async () => {
    const failing = {
      markers: async () => emptyMarkers,
      detailsWithMeta: async () => { throw new Error('offline fixture failure'); },
    } as unknown as StatiqClient;
    const app = createApp(depsWith(failing, {
      aiToolCall: toolFixture(JSON.stringify({ chosenStationIds: [999999] }), [999999]),
    }));
    const job = await startJob(app);
    await tick();
    await tick();
    const res = await app.request(`/api/jobs/plan/${job.jobId}`, {
      headers: { 'x-job-capability': job.capability },
    });
    const body = await res.json() as Record<string, unknown>;
    expect(body.state).toBe('failed');
    const error = body.error as { code: string; message: string };
    expect(error.code).toBe('not_determined');
    expect(error.message.toLowerCase()).toContain('999999');
    expect(error.message.toLowerCase()).toMatch(/candidate|usable/);
    expect(body.result).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(job.capability);
  });

  it('issues a distinct capability per job and rejects a stale one', async () => {
    const gate = deferred<StatiqMarkersResponse>();
    const statiq = { markers: async () => gate.promise } as unknown as StatiqClient;
    const app = createApp(depsWith(statiq));
    const first = await startJob(app);
    gate.resolve(emptyMarkers);
    await tick();
    await tick();
    const second = await startJob(app);
    expect(second.capability).not.toBe(first.capability);
    const stale = await app.request(`/api/jobs/plan/${second.jobId}`, {
      headers: { 'x-job-capability': first.capability },
    });
    expect(stale.status).toBe(404);
  });

  it('emits bounded host diagnostics on success without exposing them in HTTP', async () => {
    const events: Array<{ outcome: string; hostReasons: unknown[] }> = [];
    const statiq = { markers: async () => emptyMarkers } as unknown as StatiqClient;
    const app = createApp(depsWith(statiq, {
      router: endpointRouter() as never,
      aiToolCall: toolFixture('{"chosenStationIds":[],"notes":"ok"}', []),
      onPlanRunEvent: (event) => { events.push(event); },
    }));
    const job = await startJob(app);
    const res = await waitTerminal(app, job, 'succeeded');
    expect(res.status).toBe(200);
    expect(events.length).toBe(1);
    expect(events[0]?.outcome).toBe('ok');
    expect(await res.text()).not.toContain('hostReasons');
  });

  it('logs host reason codes on failure but never in the response body', async () => {
    const events: Array<{ outcome: string; hostReasons: Array<{ reasons: string[] }>;
      stationDiagnostics?: Array<{ reasons: string[]; rawChargerCount: number }>;
      coverageProfile: string; hostReasonsTotal: number; hostReasonsOmitted: number;
      matchedRuleCounts: Record<string, number>; capStateCounts: Record<string, number>;
      stationEvidence: { total: number; sampled: number; omitted: number; sampleLimit: number } }> = [];
    const broken = {
      markers: async () => ({
        ok: true, live: true, retained: false, source: 'test', count: 1,
        stations: [{ stationId: 42, name: 'Broken', lat: 28.6, lon: 77.2,
          address: null, accessType: 1, isCommunityListed: false, stationUrl: '' }],
      }),
      detailsWithMeta: async () => ({
        response: { ok: true, live: true, retained: false, source: 'test',
          station: { stationId: 42, name: 'Broken', lat: 28.6, lon: 77.2, chargers: [null] } },
        fetchedAt: new Date(),
      }),
    } as unknown as StatiqClient;
    const app = createApp(depsWith(broken, {
      aiToolCall: toolFixture(JSON.stringify({ chosenStationIds: [999999] }), [42]),
      onPlanRunEvent: (event) => { events.push(event); },
    }));
    const job = await startJob(app);
    const res = await waitTerminal(app, job, 'failed');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('hostReasons');
    expect(text).not.toContain('schema_invalid');
    expect(events.length).toBe(1);
    expect(events[0]?.hostReasons.some((r) => r.reasons.includes('schema_invalid'))).toBe(true);
    expect(events[0]?.stationDiagnostics).toHaveLength(1);
    expect(events[0]?.stationDiagnostics?.[0]).toMatchObject({
      reasons: ['schema_invalid'], rawChargerCount: 1, invalidChargerCount: 1,
    });
    expect(JSON.stringify(events[0])).not.toContain('Broken');
    expect(events[0]).toMatchObject({
      coverageProfile: 'standard20', hostReasonsTotal: 1, hostReasonsOmitted: 0,
      matchedRuleCounts: { schema_invalid: 1 }, capStateCounts: { 'no-ccs2-dc': 1 },
      stationEvidence: { total: 1, sampled: 1, omitted: 0, sampleLimit: 20 },
    });
  });
  it('forwards sanitized final-answer diagnostics to the private observer', async () => {
    const events: Array<{ outcome: string; finalAnswerEvents?: Array<{ reason: string }> }> = [];
    let n = 0;
    const app = createApp(depsWith({ markers: async () => emptyMarkers } as unknown as StatiqClient, {
      router: endpointRouter() as never,
      aiToolCall: async () => {
        n += 1;
        return n === 1
          ? { content: '{not json', toolCalls: [] }
          : { content: '{"chosenStationIds":[]}', toolCalls: [] };
      },
      onPlanRunEvent: (event) => { events.push(event); },
    }));
    const job = await startJob(app);
    const res = await waitTerminal(app, job, 'succeeded');
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.finalAnswerEvents).toEqual([
      { reason: 'invalid_final_json', contentType: 'string', contentLength: 9 },
    ]);
    expect(await res.text()).not.toContain('invalid_final_json');
  });


  it('keeps a typed no-fit terminal as a failed not-determined job', async () => {
    const events: Array<{ outcome: string; noFitDeclared: boolean }> = [];
    let n = 0;
    const statiq = {
      markers: async () => ({
        ok: true, live: true, retained: false, source: 'test', count: 1,
        stations: [{ stationId: 42, name: 'NoFit', lat: 28.6, lon: 77.2,
          address: null, accessType: 1, isCommunityListed: false, stationUrl: '' }],
      }),
      detailsWithMeta: async () => ({
        response: { ok: true, live: true, retained: false, source: 'test',
          station: { stationId: 42, name: 'NoFit', lat: 28.6, lon: 77.2, chargers: [{
            chargerId: 420, name: 'DC', type: 'DC', kw: 60, pricePerKwh: 20,
            connectors: [{ displayId: 1, connectorId: 421, type: 'CCS-2',
              status: 'faulted', available: false, note: 'PRIVATE_NOTE_SENTINEL' }],
          }] } },
        fetchedAt: new Date(),
      }),
    } as unknown as StatiqClient;
    const app = createApp(depsWith(statiq, {
      aiToolCall: async () => {
        n += 1;
        return n === 1
          ? { content: null, toolCalls: [{ id: 'c1', type: 'function',
            function: { name: 'get_station_details', arguments: '{"ids":[42]}' } }] }
          : { content: JSON.stringify({ chosenStationIds: [], notes: '',
            status: 'not_determined' }), toolCalls: [] };
      },
      onPlanRunEvent: (event) => { events.push(event); },
    }));
    const started = await app.request('/api/jobs/plan', { method: 'POST', headers,
      body: JSON.stringify({ origin: ORIGIN, destination: DEST, startSocPct: 50 }) });
    expect(started.status).toBe(202);
    const job = await started.json() as { jobId: string; capability: string };
    const res = await waitTerminal(app, job, 'failed');
    const failed = await res.json() as { error?: { code?: string } };
    expect(failed.error?.code).toBe('not_determined');
    const text = JSON.stringify(failed);
    expect(text).not.toContain('PRIVATE_NOTE_SENTINEL');
    expect(text).not.toMatch(/toolAdmission|stationDiagnostics|matchedRuleCounts|noFitDeclared/i);
    expect(events).toHaveLength(1);
    expect(events[0]?.noFitDeclared).toBe(true);
  });
  it('keeps the job outcome intact when the private observer throws', async () => {
    const app = createApp(depsWith({ markers: async () => emptyMarkers } as unknown as StatiqClient, {
      router: endpointRouter() as never,
      aiToolCall: toolFixture('{"chosenStationIds":[],"notes":"ok"}', []),
      onPlanRunEvent: () => { throw new Error('observer down'); },
    }));
    const job = await startJob(app);
    const res = await waitTerminal(app, job, 'succeeded');
    expect(res.status).toBe(200);
  });

});

describe('job progress evidence', () => {
  it('exposes typed sample counts and complete inventory while AI is pending', async () => {
    const gate = deferred<void>();
    let markerCalls = 0;
    const statiq = {
      markers: async () => {
        markerCalls += 1;
        if (markerCalls === 2) throw new Error('one sample unavailable');
        return { ok: true, live: true, retained: false, source: 'test', count: 0, stations: [] };
      },
    } as unknown as StatiqClient;
    const app = createApp(depsWith(statiq, {
      router: { route: async (from, to) => ({ distanceKm: 20, durationMin: 20,
        geometry: [from, to] }) } as never,
      aiToolCall: async () => {
        await gate.promise;
        return { content: JSON.stringify({ chosenStationIds: [] }), toolCalls: [] };
      },
    }));
    try {
      const started = await app.request('/api/jobs/plan', { method: 'POST', headers,
        body: JSON.stringify({ origin: { label: 'A', lat: 0, lon: 0 },
          destination: { label: 'B', lat: 0.18, lon: 0 } }) });
      const job = await started.json() as { jobId: string; capability: string };
      let progress: Record<string, unknown> | null = null;
      for (let i = 0; i < 200; i += 1) {
        await tick();
        const polled = await app.request(`/api/jobs/plan/${job.jobId}`, {
          headers: { 'x-job-capability': job.capability },
        });
        const body = await polled.json() as { progress?: Record<string, unknown> };
        if (body.progress && body.progress.samplesCompleted === 3 &&
            body.progress.candidateInventoryComplete === true) { progress = body.progress; break; }
      }
      expect(progress).toMatchObject({
        samplesPlanned: 3, samplesCompleted: 3, samplesOk: 2, samplesFailed: 1,
        candidatesPlanned: 0, candidateInventoryComplete: true,
      });
      gate.resolve();
      await waitTerminal(app, job, 'succeeded');
    } finally {
      gate.resolve();
    }
  });
});
