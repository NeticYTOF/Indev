import { describe, expect, it } from 'vitest';
import {
  createProviderFailureCollector,
  StatiqClient,
  UpstreamBudget,
  type UpstreamAuditEntry,
} from '../src/index.js';
import { PROVIDER_FAILURE_LIMIT } from '../src/provider-failure.js';

function response(body: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, { status, headers });
}

function clientWith(
  fetchImpl: typeof fetch,
  collector: ReturnType<typeof createProviderFailureCollector>,
  options: {
    retries?: number;
    budget?: UpstreamBudget;
    onUpstreamCall?: (entry: UpstreamAuditEntry) => void;
  } = {},
): StatiqClient {
  const client = new StatiqClient({
    token: 'fixture',
    fetchImpl,
    retries: options.retries ?? 0,
    sleepImpl: async () => {},
    ...(options.onUpstreamCall ? { onUpstreamCall: options.onUpstreamCall } : {}),
  });
  if (options.budget) client.attachRunBudget(options.budget, collector);
  else client.attachFailureCollector(collector);
  return client;
}

describe('Statiq provider failure evidence', () => {
  it('keeps dispatch sequence distinct from reversed completion audit order', async () => {
    const audit: UpstreamAuditEntry[] = [];
    const collector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    let slowRelease!: () => void;
    let fastRelease!: () => void;
    const slow = new Promise<void>((r) => { slowRelease = r; });
    const fast = new Promise<void>((r) => { fastRelease = r; });
    let call = 0;
    const fetchImpl = async (): Promise<Response> => {
      call += 1;
      if (call === 1) await slow;
      if (call === 2) await fast;
      if (call === 3) return response('bad', 400);
      return response('{"ok":true,"live":true,"retained":false,"source":"x","count":0,"stations":[]}');
    };
    const client = clientWith(fetchImpl, collector, {
      budget: new UpstreamBudget(6),
      onUpstreamCall: (entry) => audit.push(entry),
    });
    const first = client.markers(0, 0);
    const second = client.markers(1, 1);
    fastRelease();
    await second;
    slowRelease();
    await first;

    expect(audit.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(client.dispatchedAttemptsMade()).toBe(2);

    await expect(client.markers(2, 2, undefined, {
      endpointClass: 'stations/markers', phase: 'scan', sampleOrdinal: 3,
    })).rejects.toThrow();
    expect(collector.snapshot().failures).toMatchObject([{
      endpointClass: 'stations/markers',
      phase: 'scan',
      sampleOrdinal: 3,
      dispatchSeq: 3,
      httpStatus: 400,
      code: 'http_400',
    }]);
  });

  it('emits 200 body decode failures without retrying', async () => {
    const collector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      return response('not json');
    };
    const client = clientWith(fetchImpl, collector, { retries: 3, budget: new UpstreamBudget(10) });
    await expect(client.markers(0, 0)).rejects.toThrow();
    expect(calls).toBe(1);
    expect(collector.snapshot().failures).toMatchObject([{
      endpointClass: 'stations/markers',
      dispatchSeq: 1,
      httpStatus: 200,
      code: 'invalid_json',
    }]);
  });

  it('reports fatal headers once even when the body read aborts', async () => {
    const collector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const fetchImpl = async (): Promise<Response> => ({
      ok: false,
      status: 429,
      headers: { get: () => null },
      text: async () => { throw new Error('body lost'); },
    } as unknown as Response);
    const client = clientWith(fetchImpl, collector, { retries: 3, budget: new UpstreamBudget(10) });
    await expect(client.markers(0, 0)).rejects.toThrow();
    const failures = collector.snapshot().failures;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      dispatchSeq: 1,
      httpStatus: 429,
      code: 'fatal_throttled',
    });
  });

  it('reports predispatch refusal with null dispatch sequence', async () => {
    const collector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const budget = new UpstreamBudget(1);
    budget.reserveAttempt();
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      return response('not used');
    };
    const client = clientWith(fetchImpl, collector, { budget });
    await expect(client.markers(0, 0)).rejects.toThrow();
    expect(calls).toBe(0);
    expect(client.dispatchedAttemptsMade()).toBe(0);
    expect(collector.snapshot().failures).toMatchObject([{
      dispatchSeq: null,
      code: 'budget_exhausted',
    }]);
  });

  it('bounds retained failure records during execution with exact omission', async () => {
    const collector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      if (calls <= PROVIDER_FAILURE_LIMIT + 3) return response('bad', 400);
      return response('{"ok":true,"live":true,"retained":false,"source":"x","count":0,"stations":[]}');
    };
    const client = clientWith(fetchImpl, collector, {
      retries: 0,
      budget: new UpstreamBudget(PROVIDER_FAILURE_LIMIT + 4),
    });
    for (let i = 0; i < PROVIDER_FAILURE_LIMIT + 3; i++) {
      await expect(client.markers(i, i)).rejects.toThrow();
    }
    const report = collector.snapshot();
    expect(report.failures).toHaveLength(PROVIDER_FAILURE_LIMIT);
    expect(report.omittedFailureCount).toBe(3);
  });
});
