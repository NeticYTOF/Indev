/**
 * Hosted (serverless) deployment contract: the request's own https host is
 * the only extra accepted origin, process-local jobs are refused, saved
 * trips never touch the server disk, and health advertises the mode.
 * Local (non-hosted) behaviour is pinned unchanged alongside.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../src/app.js';
import { CountersStore, OsrmRouter, PhotonGeocoder, StatiqClient, TripsStore } from '@indeev/core';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

async function deps(overrides: Partial<AppDeps> = {}): Promise<AppDeps> {
  const dir = await mkdtemp(join(tmpdir(), 'indeev-hosted-'));
  dirs.push(dir);
  return {
    createStatiq: () => { throw new Error('no upstream in this test'); },
    router: {} as OsrmRouter,
    geocoder: { search: async () => [] } as unknown as PhotonGeocoder,
    trips: new TripsStore({ filePath: join(dir, 'trips.json') }),
    counters: new CountersStore({ filePath: join(dir, 'counters.json') }),
    mock: false,
    allowedWebOrigins: [],
    ...overrides,
  };
}

const ORIGIN = { label: 'Delhi', lat: 28.6139, lon: 77.209 };
const DEST = { label: 'Jaipur', lat: 26.9124, lon: 75.7873 };
const jobBody = JSON.stringify({ origin: ORIGIN, destination: DEST, engine: 'planner' });

function browserPost(path: string, origin: string, host: string, body = jobBody): Request {
  return new Request(`https://${host}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin, host, 'sec-fetch-site': 'same-origin' },
    body,
  });
}

describe('hosted deployment mode', () => {
  it('health advertises hosted only when configured', async () => {
    const hosted = await (await createApp(await deps({ hosted: true })).request('/api/health')).json() as { hosted: boolean };
    const local = await (await createApp(await deps()).request('/api/health')).json() as { hosted: boolean };
    expect(hosted.hosted).toBe(true);
    expect(local.hosted).toBe(false);
  });

  it('accepts exactly the https origin of the request host and refuses jobs after the gate', async () => {
    const app = createApp(await deps({ hosted: true }));
    const res = await app.fetch(browserPost('/api/jobs/plan', 'https://indeev.vercel.app', 'indeev.vercel.app'));
    expect(res.status).toBe(422);
    expect((await res.json() as { code: string }).code).toBe('unsupported_hosted_jobs');
  });

  it.each([
    ['another host', 'https://evil.example', 'indeev.vercel.app'],
    ['http scheme', 'http://indeev.vercel.app', 'indeev.vercel.app'],
    ['suffix confusion', 'https://indeev.vercel.app.evil.example', 'indeev.vercel.app'],
  ])('denies %s', async (_label, origin, host) => {
    const app = createApp(await deps({ hosted: true }));
    const res = await app.fetch(browserPost('/api/jobs/plan', origin, host));
    expect(res.status).toBe(403);
    expect((await res.json() as { code: string }).code).toBe('origin_denied');
  });

  it('a non-hosted server never trusts its own host as an origin', async () => {
    const app = createApp(await deps());
    const res = await app.fetch(browserPost('/api/jobs/plan', 'https://indeev.vercel.app', 'indeev.vercel.app'));
    expect(res.status).toBe(403);
  });

  it('saved-trip routes never read or write the server store when hosted', async () => {
    const trips = new TripsStore({ filePath: join(tmpdir(), 'indeev-hosted-never-written.json') });
    let touched = 0;
    for (const method of ['list', 'get', 'save', 'remove'] as const) {
      (trips as unknown as Record<string, () => never>)[method] = () => { touched += 1; throw new Error('touched'); };
    }
    const app = createApp(await deps({ hosted: true, trips }));
    for (const [path, method] of [['/api/trips', 'GET'], ['/api/trips/x', 'GET'], ['/api/trips/x', 'DELETE']] as const) {
      const res = await app.request(path, { method });
      expect(res.status).toBe(404);
      expect((await res.json() as { code: string }).code).toBe('unsupported_hosted_trips');
    }
    const save = await app.request('/api/trips', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: {} }),
    });
    expect(save.status).toBe(404);
    expect(touched).toBe(0);
  });
});
