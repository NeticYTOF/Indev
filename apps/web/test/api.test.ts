/**
 * Regression tests for the web API layer's error contract:
 * the machine-readable not_determined cause from the server body must
 * survive onto ApiError (the UI's cause-true guidance depends on it),
 * cause-less errors must stay cause-less, and a dead server must
 * classify as offline - never as a planning verdict. Also pins the
 * api.plan request/response shape for API compatibility.
 *
 * Deterministic: global fetch is stubbed; no network, no DOM, no data
 * stores touched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api.js';

interface RecordedCall {
  path: string | URL;
  init?: RequestInit;
}

function stubFetchOnce(
  respond: { status: number; body?: unknown } | { reject: Error },
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const fake = async (
    path: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ path, init });
    if ('reject' in respond) throw respond.reject;
    return new Response(JSON.stringify(respond.body), {
      status: respond.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  vi.stubGlobal('fetch', fake);
  return calls;
}

const PLAN_REQ = {
  origin: { label: 'Delhi', lat: 28.6139, lon: 77.209 },
  destination: { label: 'Jaipur', lat: 26.9124, lon: 75.7873 },
  startSocPct: 90,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ApiError cause preservation (machine-readable not_determined)', () => {
  it("carries the server's fine-grained cause onto ApiError", async () => {
    const calls = stubFetchOnce({
      status: 422,
      body: {
        error:
          'Plan not determined: the run exhausted its budget of 200 upstream attempts…',
        code: 'not_determined',
        cause: 'budget-exhausted',
      },
    });
    const err = (await api.plan(PLAN_REQ).then(
      () => new Error('expected rejection'),
      (e: unknown) => e,
    )) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('not_determined');
    expect(err.cause).toBe('budget-exhausted');
    expect(err.status).toBe(422);
    // The request shape is unchanged (API compatibility): POST /api/plan
    // with a JSON body carrying origin/destination/startSocPct.
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.path)).toBe('/api/plan');
    expect(calls[0]?.init?.method).toBe('POST');
    const sent = JSON.parse(String(calls[0]?.init?.body)) as {
      origin: { label: string };
      destination: { label: string };
      startSocPct: number;
    };
    expect(sent.origin.label).toBe('Delhi');
    expect(sent.destination.label).toBe('Jaipur');
    expect(sent.startSocPct).toBe(90);
  });

  it('leaves cause undefined for cause-less errors (no_route)', async () => {
    stubFetchOnce({
      status: 422,
      body: { error: 'No route found between these places.', code: 'no_route' },
    });
    const err = (await api.plan(PLAN_REQ).then(
      () => new Error('expected rejection'),
      (e: unknown) => e,
    )) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('no_route');
    expect(err.cause).toBeUndefined();
  });

  it('falls back to unknown code when the body is not JSON', async () => {
    // Server crashed mid-response: the cause path must degrade honestly,
    // not throw a parse error the UI cannot classify.
    vi.stubGlobal('fetch', async () => new Response('internal', { status: 500 }));
    const err = (await api.plan(PLAN_REQ).then(
      () => new Error('expected rejection'),
      (e: unknown) => e,
    )) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('unknown');
    expect(err.cause).toBeUndefined();
    expect(err.status).toBe(500);
  });

  it('classifies a dead server as offline - never a planning verdict', async () => {
    stubFetchOnce({ reject: new TypeError('fetch failed') });
    const err = (await api.plan(PLAN_REQ).then(
      () => new Error('expected rejection'),
      (e: unknown) => e,
    )) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('offline');
    expect(err.status).toBe(0);
    expect(err.cause).toBeUndefined();
  });

  it('resolves the plan response body unchanged on success', async () => {
    const plan = { id: 'plan-1', stops: [] };
    stubFetchOnce({ status: 200, body: { plan } });
    const out = (await api.plan(PLAN_REQ)) as unknown as {
      plan: { id: string; stops: unknown[] };
    };
    expect(out.plan.id).toBe('plan-1');
    expect(out.plan.stops).toEqual([]);
  });
});
