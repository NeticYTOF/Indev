import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CountersStore, OsrmRouter, PhotonGeocoder, TripsStore,
} from '@indeev/core';
import { createApp, type AppDeps } from '../src/app.js';
import type { ChatMessage } from '../src/ai-provider.js';

const validModel = JSON.stringify({ origin: 'Delhi', destination: 'Jaipur', via: [] });
const ai = { baseUrl: 'https://ai.test/v1', apiKey: 'test-key', model: 'test-model' };
const headers = { 'Content-Type': 'application/json' };
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
function aiReturning(content: string) {
  return vi.fn(async (_messages: ChatMessage[], _signal?: AbortSignal): Promise<string> => content);
}
const tempDirs: string[] = [];
function errorCode(value: unknown): unknown {
  if (value && typeof value === 'object' && 'code' in value) return value.code;
  return undefined;
}
function viaNames(value: unknown): unknown {
  if (value && typeof value === 'object' && 'via' in value) return value.via;
  return undefined;
}

async function makeDeps(overrides: Partial<AppDeps> = {}): Promise<AppDeps> {
  const dir = await mkdtemp(join(tmpdir(), 'indeev-parse-test-'));
  tempDirs.push(dir);
  return {
    createStatiq: () => { throw new Error('no station calls in parse-only route'); },
    router: { route: async () => { throw new Error('no routing in parse-only route'); } } as unknown as OsrmRouter,
    geocoder: { search: async () => { throw new Error('no geocoding in parse-only route'); } } as unknown as PhotonGeocoder,
    trips: new TripsStore({ filePath: join(dir, 'trips.json') }),
    counters: new CountersStore({ filePath: join(dir, 'counters.json') }),
    mock: false,
    ai,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('POST /api/ai/parse (parse-only)', () => {
  it('returns tentative reviewed place names with one bounded model call', async () => {
    const aiCall = aiReturning(validModel);
    const app = createApp(await makeDeps({ aiCall }));
    const res = await app.request('/api/ai/parse', { method: 'POST', headers,
      body: JSON.stringify({ text: 'Delhi to Jaipur tomorrow' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ origin: 'Delhi', destination: 'Jaipur', via: [], reviewRequired: true });
    expect(aiCall).toHaveBeenCalledTimes(1);
    const messages = aiCall.mock.calls[0]![0];
    const payload = JSON.stringify(messages);
    expect(messages[0]!.content).toMatch(/add tools/i);
    expect(payload).not.toContain('"tools":');
    expect(payload).not.toContain('"tool_calls":');
    expect(payload).not.toContain('stationId');
  });

  it('extracts ordered via names solely from text', async () => {
    const text = 'Delhi to Jaipur via Ahmedabad';
    const aiCall = aiReturning(JSON.stringify({ origin: 'Delhi', destination: 'Jaipur', via: ['Ahmedabad'] }));
    const app = createApp(await makeDeps({ aiCall }));
    const res = await app.request('/api/ai/parse', { method: 'POST', headers,
      body: JSON.stringify({ text }) });
    expect(res.status).toBe(200);
    expect(viaNames(await res.json())).toEqual(['Ahmedabad']);
    expect(aiCall.mock.calls[0]![0][1]!.content).toBe(text);
  });

  it.each([
    ['not JSON', 'nope'],
    ['array root', '[]'],
    ['empty text', JSON.stringify({ text: '' })],
    ['long text', JSON.stringify({ text: 'x'.repeat(801) })],
    ['extra field', JSON.stringify({ text: 'A to B', origin: 'A' })],
    ['via field', JSON.stringify({ text: 'A to B', via: ['A'] })],
  ])('rejects %s before any provider call', async (_name, body) => {
    const aiCall = aiReturning(validModel);
    const app = createApp(await makeDeps({ aiCall }));
    const res = await app.request('/api/ai/parse', { method: 'POST', headers, body });
    expect(res.status).toBe(400);
    expect(aiCall).not.toHaveBeenCalled();
  });

  it('enforces browser and JSON gates before parsing', async () => {
    const aiCall = aiReturning(validModel);
    const app = createApp(await makeDeps({ aiCall }));
    const crossSite = await app.request('/api/ai/parse', { method: 'POST', headers: {
      'Content-Type': 'application/json', origin: 'https://evil.example',
    }, body: JSON.stringify({ text: 'A to B' }) });
    expect(crossSite.status).toBe(403);
    const wrongType = await app.request('/api/ai/parse', { method: 'POST',
      headers: { 'Content-Type': 'text/plain' }, body: 'A to B' });
    expect(wrongType.status).toBe(400);
    expect(aiCall).not.toHaveBeenCalled();
  });

  it('fails clearly without a provider call in mock or disabled modes', async () => {
    const aiCall = aiReturning(validModel);
    const body = JSON.stringify({ text: 'A to B' });
    const mockRes = await createApp(await makeDeps({ aiCall, mock: true }))
      .request('/api/ai/parse', { method: 'POST', headers, body });
    expect(mockRes.status).toBe(503);
    expect(errorCode(await mockRes.json())).toBe('mock_parse_unavailable');
    const offRes = await createApp(await makeDeps({ aiCall, ai: undefined }))
      .request('/api/ai/parse', { method: 'POST', headers, body });
    expect(offRes.status).toBe(503);
    expect(errorCode(await offRes.json())).toBe('ai_disabled');
    expect(aiCall).not.toHaveBeenCalled();
  });

  it('rejects untrusted output without retry or raw model text in errors', async () => {
    const aiCall = aiReturning('SECRET RAW MODEL RESPONSE');
    const app = createApp(await makeDeps({ aiCall }));
    const res = await app.request('/api/ai/parse', { method: 'POST', headers,
      body: JSON.stringify({ text: 'A to B' }) });
    expect(res.status).toBe(502);
    const payload = await res.text();
    expect(errorCode(JSON.parse(payload))).toBe('parse_failed');
    expect(aiCall).toHaveBeenCalledTimes(1);
    expect(payload).not.toContain('SECRET');
  });

  it('sanitizes provider errors and never retries', async () => {
    const aiCall = vi.fn(async (_messages: ChatMessage[], _signal?: AbortSignal): Promise<string> => {
      throw new AiProviderError('SECRET KEY LEAK');
    });
    const app = createApp(await makeDeps({ aiCall }));
    const res = await app.request('/api/ai/parse', { method: 'POST', headers,
      body: JSON.stringify({ text: 'A to B' }) });
    expect(res.status).toBe(502);
    const payload = await res.text();
    expect(errorCode(JSON.parse(payload))).toBe('ai_provider');
    expect(aiCall).toHaveBeenCalledTimes(1);
    expect(payload).not.toContain('SECRET');
  });

  it('shares the server run slot', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const aiCall = vi.fn(async (_messages: ChatMessage[], _signal?: AbortSignal): Promise<string> => {
      if (first) { first = false; await gate; }
      return validModel;
    });
    const app = createApp(await makeDeps({ aiCall }));
    const body = JSON.stringify({ text: 'A to B' });
    const pending = app.request('/api/ai/parse', { method: 'POST', headers, body });
    for (let i = 0; i < 20 && aiCall.mock.calls.length === 0; i += 1) await tick();
    const busy = await app.request('/api/ai/parse', { method: 'POST', headers, body });
    expect(busy.status).toBe(503);
    expect(errorCode(await busy.json())).toBe('run_busy');
    release();
    expect((await pending).status).toBe(200);
  });

  it('honors cancellation while the body is still streaming', async () => {
    const aiCall = aiReturning(validModel);
    const app = createApp(await makeDeps({ aiCall }));
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({ start: () => {} });
    const request = new Request('http://localhost/api/ai/parse', { method: 'POST',
      headers, body, signal: controller.signal, duplex: 'half' } as RequestInit);
    const pending = app.request(request);
    await tick();
    controller.abort();
    const res = await pending;
    expect(res.status).toBe(499);
    expect(aiCall).not.toHaveBeenCalled();
  });

  it('rejects model output with extra keys without retry', async () => {
    const aiCall = aiReturning(JSON.stringify({
      origin: 'Delhi', destination: 'Jaipur', via: [], chargers: [{ stationId: 1 }],
    }));
    const app = createApp(await makeDeps({ aiCall }));
    const res = await app.request('/api/ai/parse', { method: 'POST', headers,
      body: JSON.stringify({ text: 'A to B' }) });
    expect(res.status).toBe(502);
    expect(errorCode(await res.json())).toBe('parse_failed');
    expect(aiCall).toHaveBeenCalledTimes(1);
  });

  it('sanitizes unexpected non-provider adapter rejections', async () => {
    const aiCall = vi.fn(async (_messages: ChatMessage[], _signal?: AbortSignal): Promise<string> => {
      throw new Error('SECRET UPSTREAM TEXT');
    });
    const app = createApp(await makeDeps({ aiCall }));
    const res = await app.request('/api/ai/parse', { method: 'POST', headers,
      body: JSON.stringify({ text: 'A to B' }) });
    expect(res.status).toBe(502);
    const payload = await res.text();
    expect(errorCode(JSON.parse(payload))).toBe('ai_provider');
    expect(payload).not.toContain('SECRET');
    expect(aiCall).toHaveBeenCalledTimes(1);
  });

  it('returns cancellation even when underlying cancel never settles', { timeout: 1000 }, async () => {
    const aiCall = aiReturning(validModel);
    const app = createApp(await makeDeps({ aiCall }));
    const controller = new AbortController();
    const never = new Promise<void>(() => {});
    const body = new ReadableStream<Uint8Array>({
      start: () => {},
      cancel: () => never,
    });
    const request = new Request('http://localhost/api/ai/parse', { method: 'POST',
      headers, body, signal: controller.signal, duplex: 'half' } as RequestInit);
    const pending = app.request(request);
    await tick();
    controller.abort();
    expect((await pending).status).toBe(499);
    expect(aiCall).not.toHaveBeenCalled();
  });

  it('prioritizes cancellation over late malformed model output', async () => {
    const controller = new AbortController();
    const aiCall = vi.fn(async (_messages: ChatMessage[], _signal?: AbortSignal): Promise<string> => {
      controller.abort();
      return 'NOT JSON';
    });
    const app = createApp(await makeDeps({ aiCall }));
    const res = await app.request('/api/ai/parse', { method: 'POST', headers,
      body: JSON.stringify({ text: 'A to B' }), signal: controller.signal });
    expect(res.status).toBe(499);
    expect(errorCode(await res.json())).toBe('cancelled');
    expect(aiCall).toHaveBeenCalledTimes(1);
  });
});
