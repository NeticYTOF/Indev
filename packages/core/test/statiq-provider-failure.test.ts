import { describe, expect, it } from 'vitest';
import {
  createProviderFailureCollector,
  StatiqClient,
  UpstreamBudget,
  type UpstreamAuditEntry,
} from '../src/index.js';
import { PROVIDER_FAILURE_LIMIT } from '../src/provider-failure.js';

function response(body: string, status = 200, headers: Record<string, string> = {}): Response {
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
    maxCallsPerMinute: 1_000_000,
    minCallGapMs: 0,
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

  it('records each existing 200 body-decode retry with a dispatch sequence', async () => {
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
    expect(calls).toBe(4);
    const records = collector.snapshot().failures;
    expect(records).toHaveLength(4);
    expect(records.map((r) => r.dispatchSeq)).toEqual([1, 2, 3, 4]);
    expect(records.every((r) => r.httpStatus === 200 && r.code === 'invalid_json')).toBe(true);
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

  it('records one HTTP500 evidence entry per existing retry attempt', async () => {
    const collector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      return response('bad', 500);
    };
    const client = clientWith(fetchImpl, collector, { retries: 2, budget: new UpstreamBudget(8) });
    await expect(client.markers(0, 0)).rejects.toThrow();
    expect(calls).toBe(3);
    const records = collector.snapshot().failures;
    expect(records.map((record) => record.dispatchSeq)).toEqual([1, 2, 3]);
    expect(records.every((record) => record.httpStatus === 500 && record.code === 'http_5xx')).toBe(true);
  });

  it('records one abort entry after 200 headers while retaining the status', async () => {
    const collector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const controller = new AbortController();
    const fetchImpl = async (): Promise<Response> => {
      controller.abort();
      return response('{"ok":true}', 200);
    };
    const client = clientWith(fetchImpl, collector, { budget: new UpstreamBudget(2) });
    await expect(client.markers(0, 0, controller.signal)).rejects.toThrow();
    const records = collector.snapshot().failures;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ httpStatus: 200, code: 'deadline', dispatchSeq: 1 });
  });

  it('keeps predispatch null-sequence refusals distinct and never uses a global dedupe set', async () => {
    const collector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const budget = new UpstreamBudget(1);
    budget.reserveAttempt();
    const client = clientWith(
      async () => { throw new Error('must not dispatch'); },
      collector,
      { budget },
    );
    await expect(client.markers(0, 0)).rejects.toThrow();
    await expect(client.markers(1, 1)).rejects.toThrow();

    const records = collector.snapshot().failures;
    expect(records).toHaveLength(2);
    expect(records.every((record) =>
      record.code === 'budget_exhausted' && record.dispatchSeq === null)).toBe(true);
    expect(client.dispatchedAttemptsMade()).toBe(0);
  });
});
