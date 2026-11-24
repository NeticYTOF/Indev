import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CountersStore, TripsStore,
  type OsrmRouter, type PhotonGeocoder, type StatiqCharger, type StatiqClient,
  type StatiqDetailsResponse, type StatiqMarkersResponse, type StatiqStationDetail,
} from '@indeev/core';
import { createApp, type AppDeps } from '../src/app.js';
import {
  AI_KEY_HEADER, AI_MODEL_HEADER, AI_PROVIDER_HEADER, AI_PROVIDERS, publicProviderList, readRequestAi,
} from '../src/ai-byok.js';
import { providerStatusMessage } from '../src/ai-provider.js';
import { endpointRouter } from '../../../packages/core/test/support/road-fixture.js';

const DEVICE_KEY = 'sk-device-ONLY-7f3a9c2e51';
const SERVER_AI = { baseUrl: 'https://server.example/v1', apiKey: 'server-env-key-123', model: 'server-model' };
const KM_PER_DEG = 111.32;
const TOTAL_KM = 700;
const ORIGIN = { label: 'Origin', lat: 0, lon: 0 };
const DEST = { label: 'Destination', lat: TOTAL_KM / KM_PER_DEG, lon: 0 };
const json = { 'Content-Type': 'application/json' };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const stations = Array.from({ length: 14 }, (_, i) => ({ id: 700 + i, name: `Statiq ${i}`, chainageKm: 50 * (i + 1) }));

function detail(spec: { id: number; name: string; chainageKm: number }): StatiqStationDetail {
  const chargers: StatiqCharger[] = [{
    chargerId: spec.id * 10 + 1, name: `${spec.name} DC`, type: 'DC', kw: 60, pricePerKwh: 20,
    currency: 'INR', lastUsedOn: '19/11/2026',
    connectors: [{ displayId: 1, connectorId: spec.id * 100, type: 'CCS-2', status: 'available', available: true, note: null }],
  }];
  return {
    stationId: spec.id, name: spec.name, lat: spec.chainageKm / KM_PER_DEG, lon: 0,
    address: null, area: null, city: null, landmark: null, hours: '00:00 To 23:59', openText: 'Open Now',
    rating: 4, reviewCount: 100, accessType: 'public', navUrl: '', stationUrl: '', imageUrl: null,
    amenities: [], stepsToReach: null, chargers, summary: null,
  };
}

function fakeStatiq(): StatiqClient {
  const details = new Map(stations.map((s) => [s.id, detail(s)]));
  return {
    markers: async (lat: number): Promise<StatiqMarkersResponse> => {
      const centerKm = lat * KM_PER_DEG;
      const found = stations.filter((s) => Math.abs(s.chainageKm - centerKm) <= 13).map((s) => ({
        stationId: s.id, name: s.name, lat: s.chainageKm / KM_PER_DEG, lon: 0, address: null,
        accessType: 1, isCommunityListed: false, stationUrl: '',
      }));
      return { ok: true, live: true, retained: false, source: 'test', count: found.length, stations: found };
    },
    detailsWithMeta: async (id: number): Promise<{ response: StatiqDetailsResponse; fetchedAt: Date }> => ({
      response: { ok: true, live: true, retained: false, source: 'test', station: details.get(id) ?? null },
      fetchedAt: new Date(),
    }),
  } as unknown as StatiqClient;
}

interface Captured { url: string; auth: string | null; body: string }

/** Provider transport that records every outgoing request and answers with a
 *  final zero-stop JSON choice (or a fixed HTTP status). */
function captureFetch(status = 200): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), auth: headers.get('authorization'), body: String(init?.body ?? '') });
    if (status !== 200) return new Response('provider says: bad key sk-leak', { status });
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '{"chosenStationIds":[],"notes":"device key run"}' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

async function makeDeps(overrides: Partial<AppDeps> = {}): Promise<AppDeps> {
  const dir = await mkdtemp(join(tmpdir(), 'indeev-byok-test-'));
  tempDirs.push(dir);
  return {
    createStatiq: () => fakeStatiq(),
    router: endpointRouter() as unknown as OsrmRouter,
    geocoder: {} as PhotonGeocoder,
    trips: new TripsStore({ filePath: join(dir, 'trips.json') }),
    counters: new CountersStore({ filePath: join(dir, 'counters.json') }),
    mock: false,
    ...overrides,
  };
}

function byokHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...json, [AI_KEY_HEADER]: DEVICE_KEY, ...extra };
}

async function waitTerminal(app: ReturnType<typeof createApp>, job: { jobId: string; capability: string }) {
  for (let i = 0; i < 400; i += 1) {
    await tick();
    const res = await app.request(`/api/jobs/plan/${job.jobId}`, { headers: { 'x-job-capability': job.capability } });
    const text = await res.text();
    const status = JSON.parse(text) as { state: string };
    if (status.state !== 'running') return { status, text };
  }
  throw new Error('job did not settle');
}

describe('readRequestAi', () => {
  const from = (h: Record<string, string>) => (name: string) => h[name];

  it('falls back to the server key when no device key is sent', () => {
    expect(readRequestAi(from({}), SERVER_AI)).toEqual({ ok: true, ai: SERVER_AI, source: 'server' });
    expect(readRequestAi(from({}), undefined)).toEqual({ ok: true, ai: undefined, source: 'none' });
    expect(readRequestAi(from({ [AI_KEY_HEADER]: '   ' }), undefined)).toEqual({ ok: true, ai: undefined, source: 'none' });
  });

  it('uses the allowlisted provider base URL with the device key, defaulting to Hack Club', () => {
    const r = readRequestAi(from({ [AI_KEY_HEADER]: ` ${DEVICE_KEY} ` }), SERVER_AI);
    expect(r).toEqual({ ok: true, source: 'device', ai: {
      baseUrl: AI_PROVIDERS.hackclub.baseUrl, apiKey: DEVICE_KEY, model: AI_PROVIDERS.hackclub.defaultModel } });
    const g = readRequestAi(from({ [AI_KEY_HEADER]: DEVICE_KEY, [AI_PROVIDER_HEADER]: 'groq', [AI_MODEL_HEADER]: 'llama-3.1-8b-instant' }), undefined);
    expect(g).toMatchObject({ ok: true, ai: { baseUrl: AI_PROVIDERS.groq.baseUrl, model: 'llama-3.1-8b-instant' } });
  });

  it.each([
    ['short', 'abc'],
    ['whitespace', 'sk-has space-123'],
    ['non-ascii', 'sk-ключ-123456'],
    ['too long', 'k'.repeat(513)],
  ])('rejects a malformed key (%s) without echoing it', (_label, key) => {
    const r = readRequestAi(from({ [AI_KEY_HEADER]: key }), undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain(key.trim());
  });

  it('rejects unknown providers and URL-shaped provider values (no client base URL)', () => {
    for (const provider of ['evil', 'https://attacker.example/v1', '__proto__', 'constructor']) {
      const r = readRequestAi(from({ [AI_KEY_HEADER]: DEVICE_KEY, [AI_PROVIDER_HEADER]: provider }), undefined);
      expect(r.ok, provider).toBe(false);
    }
  });

  it('rejects malformed model names', () => {
    for (const model of ['has space', 'a'.repeat(129), 'x;rm -rf', 'm\nn']) {
      expect(readRequestAi(from({ [AI_KEY_HEADER]: DEVICE_KEY, [AI_MODEL_HEADER]: model }), undefined).ok).toBe(false);
    }
  });
});

describe('device AI key over HTTP', () => {
  it('health advertises BYOK and the provider list with no secrets', async () => {
    const app = createApp(await makeDeps({ ai: SERVER_AI }));
    const text = await (await app.request('/api/health')).text();
    const body = JSON.parse(text) as { ai: boolean; aiByok: boolean; aiProviders: unknown };
    expect(body.ai).toBe(true);
    expect(body.aiByok).toBe(true);
    expect(body.aiProviders).toEqual(publicProviderList());
    expect(text).not.toContain(SERVER_AI.apiKey);
    expect(text).not.toContain('baseUrl');
    const mock = await (await createApp(await makeDeps({ mock: true })).request('/api/health')).json() as { aiByok: boolean };
    expect(mock.aiByok).toBe(false);
  });

  it('a job with a device key sends it only to the provider and never exposes it in status', async () => {
    const cap = captureFetch();
    const logs: string[] = [];
    for (const method of ['log', 'error', 'warn', 'info'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    }
    const events: string[] = [];
    const app = createApp(await makeDeps({
      aiFetch: cap.fetch,
      onRunComplete: (...args) => events.push(JSON.stringify(args)),
      onPlanRunEvent: (event) => events.push(JSON.stringify(event)),
    }));
    const start = await app.request('/api/jobs/plan', {
      method: 'POST', headers: byokHeaders({ [AI_PROVIDER_HEADER]: 'openrouter' }),
      body: JSON.stringify({ origin: ORIGIN, destination: DEST, request: 'prefer cafes' }),
    });
    expect(start.status).toBe(202);
    const startText = await start.text();
    expect(startText).not.toContain(DEVICE_KEY);
    const { status, text } = await waitTerminal(app, JSON.parse(startText));
    expect(cap.calls.length).toBeGreaterThan(0);
    for (const call of cap.calls) {
      expect(call.url).toBe(`${AI_PROVIDERS.openrouter.baseUrl}/chat/completions`);
      expect(call.auth).toBe(`Bearer ${DEVICE_KEY}`);
      expect(call.body).not.toContain(DEVICE_KEY);
      expect(call.body).toContain(AI_PROVIDERS.openrouter.defaultModel);
    }
    expect(['succeeded', 'failed']).toContain(status.state);
    expect(text).not.toContain(DEVICE_KEY);
    expect(events.join('\n')).not.toContain(DEVICE_KEY);
    expect(logs.join('\n')).not.toContain(DEVICE_KEY);
  });

  it('enables AI on a server with no env key only when a device key is sent', async () => {
    const app = createApp(await makeDeps({ aiFetch: captureFetch().fetch }));
    const body = JSON.stringify({ origin: ORIGIN, destination: DEST });
    const off = await app.request('/api/jobs/plan', { method: 'POST', headers: json, body });
    expect(off.status).toBe(503);
    expect(((await off.json()) as { code: string }).code).toBe('ai_disabled');
    const bad = await app.request('/api/jobs/plan', { method: 'POST', headers: byokHeaders({ [AI_PROVIDER_HEADER]: 'nope' }), body });
    expect(bad.status).toBe(400);
    const badText = await bad.text();
    expect(JSON.parse(badText).code).toBe('bad_ai_config');
    expect(badText).not.toContain(DEVICE_KEY);
  });

  it('rules-only planner jobs ignore a key header and never call a provider', async () => {
    const cap = captureFetch();
    const app = createApp(await makeDeps({ aiFetch: cap.fetch }));
    const res = await app.request('/api/jobs/plan', {
      method: 'POST', headers: byokHeaders({ [AI_PROVIDER_HEADER]: 'nope' }),
      body: JSON.stringify({ origin: ORIGIN, destination: DEST, engine: 'planner', searchMode: 'smart' }),
    });
    expect(res.status).toBe(202);
    await waitTerminal(app, await res.json() as { jobId: string; capability: string });
    expect(cap.calls).toHaveLength(0);
  });

  it('a device key overrides the server key on the sync AI route', async () => {
    const cap = captureFetch();
    const app = createApp(await makeDeps({ ai: SERVER_AI, aiFetch: cap.fetch }));
    await app.request('/api/ai/plan', {
      method: 'POST', headers: byokHeaders(), body: JSON.stringify({ origin: ORIGIN, destination: DEST }),
    });
    expect(cap.calls.length).toBeGreaterThan(0);
    expect(cap.calls.every((c) => c.auth === `Bearer ${DEVICE_KEY}`)).toBe(true);
    expect(cap.calls.every((c) => c.url.startsWith(AI_PROVIDERS.hackclub.baseUrl))).toBe(true);
  });

  it('a rejected key surfaces a clear, body-free message to the user', async () => {
    const app = createApp(await makeDeps({ aiFetch: captureFetch(401).fetch }));
    const res = await app.request('/api/jobs/plan', {
      method: 'POST', headers: byokHeaders(), body: JSON.stringify({ origin: ORIGIN, destination: DEST }),
    });
    const { status, text } = await waitTerminal(app, await res.json() as { jobId: string; capability: string });
    expect(status.state).toBe('failed');
    expect(text).toContain('AI provider rejected the API key (HTTP 401)');
    expect(text).not.toContain('sk-leak');
    expect(text).not.toContain(DEVICE_KEY);
  });

  it('mock mode ignores a device key and never calls a provider', async () => {
    const cap = captureFetch();
    const app = createApp(await makeDeps({ mock: true, aiFetch: cap.fetch }));
    const res = await app.request('/api/ai/plan', {
      method: 'POST', headers: byokHeaders(), body: JSON.stringify({ origin: ORIGIN, destination: DEST }),
    });
    expect(res.status).toBe(200);
    expect(cap.calls).toHaveLength(0);
  });
});

describe('providerStatusMessage', () => {
  it('maps auth and rate-limit statuses to actionable text', () => {
    expect(providerStatusMessage(401)).toMatch(/rejected the API key \(HTTP 401\)/);
    expect(providerStatusMessage(403)).toMatch(/HTTP 403/);
    expect(providerStatusMessage(429)).toMatch(/rate-limited/);
    expect(providerStatusMessage(500)).toBe('AI provider returned 500');
  });
});
