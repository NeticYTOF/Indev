import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CountersStore, StatiqProvenanceError, TripsStore } from '@indeev/core';
import { createApp, type AppDeps } from '../src/app.js';
import { endpointRouter } from '../../../packages/core/test/support/road-fixture.js';

type DetailFn = (...args: unknown[]) => Promise<{ response: unknown; fetchedAt: Date }>;
type AiFn = (...args: unknown[]) => Promise<{ content: null; toolCalls: [] }>;
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const headers = { 'Content-Type': 'application/json' };
const body = JSON.stringify({
  origin: { label: 'A', lat: 28.6139, lon: 77.209 },
  destination: { label: 'B', lat: 26.9239, lon: 75.8267 },
  startSocPct: 50,
});

async function deps(): Promise<{ appDeps: AppDeps; detail: DetailFn; ai: AiFn }> {
  dirs.push(await mkdtemp(join(tmpdir(), 'indev-bulk-boundary-')));
  const dir = dirs[dirs.length - 1]!;
  const detail = vi.fn(async () => ({ response: { ok: false }, fetchedAt: new Date() }));
  const ai = vi.fn(async () => ({ content: null, toolCalls: [] }));
  const appDeps: AppDeps = {
    mock: false,
    createStatiq: () => ({
      bulkSupported: () => true,
      attachRunBudget: () => {},
      markers: async () => { throw new Error('legacy marker fallback forbidden'); },
      markersBulk: async () => { throw new StatiqProvenanceError('/stations/markers-bulk', 'envelope_contract'); },
      detailsWithMeta: detail,
    } as never),
    router: endpointRouter() as unknown as AppDeps['router'],
    geocoder: {} as never,
    trips: new TripsStore({ filePath: join(dir, 'trips.json') }),
    counters: new CountersStore({ filePath: join(dir, 'counters.json') }),
    ai: { baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm' },
    aiToolCall: ai as never,
  };
  return { appDeps, detail, ai };
}

async function progressDeps(): Promise<{ appDeps: AppDeps; detail: DetailFn; ai: AiFn }> {
  const base = await deps();
  const emptyMarkers = { ok: true, live: true, retained: false,
    source: 'raw-confirmed-empty', count: 0, stations: [] };
  return { ...base, appDeps: { ...base.appDeps,
    createStatiq: () => ({
      bulkSupported: () => true,
      attachRunBudget: () => {},
      markers: async () => { throw new Error('legacy marker fallback forbidden'); },
      markersBulk: async (points: readonly unknown[], _signal: unknown, _context: unknown,
        onItem?: (item: unknown, index: number) => void) => {
        const good = Math.min(12, points.length);
        for (let i = 0; i < good; i += 1) {
          onItem?.({ outcome: 'confirmed-empty', reason: null, response: emptyMarkers }, i);
        }
        throw new StatiqProvenanceError('/stations/markers-bulk', 'envelope_contract');
      },
      detailsWithMeta: base.detail,
    } as never),
  } };
}

describe('whole-bulk failure at sync/job boundary', () => {
  it('stops sync AI planning before model or detail dispatch', async () => {
    const { appDeps, detail, ai } = await deps();
    const response = await createApp(appDeps).request('/api/ai/plan',
      { method: 'POST', headers, body });
    const json = await response.json() as { code?: string; error?: string; plan?: unknown };
    expect(response.status).toBe(422);
    expect(json.code).toBe('not_determined');
    expect(json.error).toContain('envelope_contract');
    expect(json.plan).toBeUndefined();
    expect(detail).not.toHaveBeenCalled();
    expect(ai).not.toHaveBeenCalled();
  });

  it('stops long-job AI planning before model or detail dispatch', async () => {
    const { appDeps, detail, ai } = await deps();
    const app = createApp(appDeps);
    const started = await app.request('/api/jobs/plan', { method: 'POST', headers, body });
    const job = await started.json() as { jobId: string; capability: string };
    let state = 'running';
    for (let i = 0; i < 200 && state === 'running'; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const polled = await app.request(`/api/jobs/plan/${job.jobId}`,
        { headers: { 'x-job-capability': job.capability } });
      const status = await polled.json() as { state: string };
      state = status.state;
    }
    expect(state).toBe('failed');
    expect(detail).not.toHaveBeenCalled();
    expect(ai).not.toHaveBeenCalled();
  });

  it('keeps confirmed discovery progress in sync terminal coverage', async () => {
    const { appDeps, detail, ai } = await progressDeps();
    const response = await createApp(appDeps).request('/api/ai/plan',
      { method: 'POST', headers, body });
    const json = await response.json() as {
      code?: string;
      coverage?: { samplesCompleted: number; samplesOk: number; samplesFailed: number;
        samplesPlanned: number };
    };
    expect(json.code).toBe('not_determined');
    expect(json.coverage).toMatchObject({ samplesCompleted: 12, samplesOk: 12,
      samplesFailed: 0 });
    expect(json.coverage!.samplesPlanned).toBeGreaterThan(12);
    expect(detail).not.toHaveBeenCalled();
    expect(ai).not.toHaveBeenCalled();
  });

  it('keeps confirmed discovery progress in long-job terminal coverage', async () => {
    const { appDeps, detail, ai } = await progressDeps();
    const app = createApp(appDeps);
    const started = await app.request('/api/jobs/plan', { method: 'POST', headers, body });
    const job = await started.json() as { jobId: string; capability: string };
    let terminal: { state: string; error?: { coverage?: {
      samplesCompleted: number; samplesOk: number; samplesFailed: number;
      samplesPlanned: number;
    } } } | undefined;
    for (let i = 0; i < 200 && terminal?.state !== 'failed'; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const polled = await app.request(`/api/jobs/plan/${job.jobId}`,
        { headers: { 'x-job-capability': job.capability } });
      terminal = await polled.json() as typeof terminal;
    }
    expect(terminal?.state).toBe('failed');
    expect(terminal?.error?.coverage).toMatchObject({ samplesCompleted: 12, samplesOk: 12,
      samplesFailed: 0 });
    expect(terminal?.error?.coverage!.samplesPlanned).toBeGreaterThan(12);
    expect(detail).not.toHaveBeenCalled();
    expect(ai).not.toHaveBeenCalled();
  });
});
