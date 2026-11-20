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

  it('reads gateway headers only from failed marker responses', async () => {
    const collector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const success = clientWith(
      async () => response('{}', 200, {
        'x-evroute-failure-code': 'upstream_http',
        'x-evroute-upstream-status': '429',
      }),
      collector,
      { budget: new UpstreamBudget(2) },
    );
    await success.markers(0, 0);
    expect(collector.snapshot().failures).toHaveLength(0);

    const detailCollector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const detailClient = clientWith(
      async () => response('bad', 400, {
        'x-evroute-failure-code': 'upstream_http',
        'x-evroute-upstream-status': '429',
      }),
      detailCollector,
      { budget: new UpstreamBudget(2) },
    );
    await expect(detailClient.detailsWithMeta(1)).rejects.toThrow();
    const detailRecords = detailCollector.snapshot().failures;
    expect(detailRecords[0]).toMatchObject({
      endpointClass: 'stations/details', code: 'http_400',
      gatewayFailureCode: null, gatewayUpstreamStatus: null,
    });

    const failedCollector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const failedClient = clientWith(
      async () => response('bad', 500, {
        'x-evroute-failure-code': 'upstream_http',
        'x-evroute-upstream-status': '429',
      }),
      failedCollector,
      { retries: 0, budget: new UpstreamBudget(2) },
    );
    await expect(failedClient.markers(0, 0)).rejects.toThrow();
    expect(failedCollector.snapshot().failures[0]).toMatchObject({
      endpointClass: 'stations/markers', code: 'http_5xx', httpStatus: 500,
      gatewayFailureCode: 'upstream_http', gatewayUpstreamStatus: 429,
    });
  });

  it('invalid gateway headers do not alter private 400-wait classification or its one-call stop', async () => {
    const collector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    let calls = 0;
    const client = clientWith(
      async () => {
        calls += 1;
        return response('{"error":"wait"}', 400, {
          'x-evroute-failure-code': ' UPSTREAM_HTTP',
          'x-evroute-upstream-status': '+429',
        });
      },
      collector,
      { retries: 2, budget: new UpstreamBudget(8) },
    );
    await expect(client.markers(0, 0)).rejects.toThrow();
    expect(calls).toBe(1);
    expect(collector.snapshot().failures).toMatchObject([{
      endpointClass: 'stations/markers', code: 'http_400', httpStatus: 400,
      dispatchSeq: 1, gatewayFailureCode: null, gatewayUpstreamStatus: null,
    }]);
  });

  it('invalid gateway headers do not alter normal 5xx retries', async () => {
    const collector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    let calls = 0;
    const client = clientWith(
      async () => {
        calls += 1;
        return response('bad', 500, {
          'x-evroute-failure-code': ' UPSTREAM_HTTP',
          'x-evroute-upstream-status': '+429',
        });
      },
      collector,
      { retries: 2, budget: new UpstreamBudget(8) },
    );
    await expect(client.markers(0, 0)).rejects.toThrow();
    expect(calls).toBe(3);
    const records = collector.snapshot().failures;
    expect(records.every((record) =>
      record.gatewayFailureCode === null && record.gatewayUpstreamStatus === null)).toBe(true);
    expect(records.map((record) => record.dispatchSeq)).toEqual([1, 2, 3]);
  });

  it('keeps header-read anomalies and 429 fatal-header policy neutral', async () => {
    const collector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const hostileHeaders = new Proxy(new Headers(), {
      get(target, prop, receiver) {
        if (prop === 'get') {
          return (name: string) => {
            if (name === 'x-evroute-failure-code') throw new Error('header trap');
            return target.get.call(target, name);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const res = {
      ok: true,
      status: 200,
      headers: hostileHeaders,
      text: async () => '{"ok":true,"live":true,"retained":false,"source":"x","count":0,"stations":[]}',
    } as unknown as Response;
    const client = clientWith(async () => res, collector, { budget: new UpstreamBudget(2) });
    await expect(client.markers(0, 0)).resolves.toBeDefined();
    expect(collector.snapshot().failures).toHaveLength(0);

    const fatalCollector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    let fatalCalls = 0;
    const fatalClient = clientWith(
      async () => {
        fatalCalls += 1;
        return response('{"error":"wait"}', 429, {
          'Retry-After': '1',
          'x-evroute-failure-code': 'upstream_http',
          'x-evroute-upstream-status': '429',
        });
      },
      fatalCollector,
      { retries: 3, budget: new UpstreamBudget(8) },
    );
    await expect(fatalClient.markers(0, 0)).rejects.toThrow();
    expect(fatalCalls).toBe(1);
    expect(fatalCollector.snapshot().failures).toMatchObject([{
      code: 'fatal_throttled', httpStatus: 429,
      gatewayFailureCode: 'upstream_http', gatewayUpstreamStatus: 429,
    }]);
  });

  it('neutralizes failed marker header getter and invalid header object faults', async () => {
    const firstCollector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    let calls = 0;
    const first = clientWith(
      async () => {
        calls += 1;
        return {
          ok: false,
          status: 400,
          headers: {
            get(name: string) {
              if (name === 'x-evroute-failure-code') throw new Error('code header trap');
              return null;
            },
          },
          text: async () => '{"error":"wait"}',
        } as unknown as Response;
      },
      firstCollector,
      { retries: 0, budget: new UpstreamBudget(3) },
    );
    await expect(first.markers(0, 0)).rejects.toThrow();
    expect(calls).toBe(1);
    expect(firstCollector.snapshot().failures).toMatchObject([{
      endpointClass: 'stations/markers', code: 'http_400', httpStatus: 400,
      gatewayFailureCode: null, gatewayUpstreamStatus: null,
    }]);

    const secondCollector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const second = clientWith(
      async () => ({
        ok: false,
        status: 400,
        headers: { get: 42 },
        text: async () => '{"error":"wait"}',
      } as unknown as Response),
      secondCollector,
      { retries: 0, budget: new UpstreamBudget(3) },
    );
    await expect(second.markers(0, 0)).rejects.toThrow();
    expect(secondCollector.snapshot().failures).toMatchObject([{
      endpointClass: 'stations/markers', code: 'http_400', httpStatus: 400,
      gatewayFailureCode: null, gatewayUpstreamStatus: null,
    }]);

    const thirdCollector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const thirdResponse = { ok: false, status: 400, text: async () => '{"error":"wait"}' } as Record<string, unknown>;
    Object.defineProperty(thirdResponse, 'headers', {
      get() { throw new Error('headers property trap'); },
    });
    const third = clientWith(async () => thirdResponse as unknown as Response, thirdCollector, {
      retries: 0, budget: new UpstreamBudget(3),
    });
    await expect(third.markers(0, 0)).rejects.toThrow();
    expect(thirdCollector.snapshot().failures).toMatchObject([{
      endpointClass: 'stations/markers', code: 'http_400', httpStatus: 400,
      gatewayFailureCode: null, gatewayUpstreamStatus: null,
    }]);
  });

  it('keeps mixed concurrent gateway evidence isolated by response boundary', async () => {
    const collector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const validMarkers = '{"ok":true,"live":true,"retained":false,"source":"x","count":0,"stations":[]}';
    const client = clientWith(
      async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (body.station_id != null) {
          return response('bad', 400, {
            'x-evroute-failure-code': 'upstream_http',
            'x-evroute-upstream-status': '599',
          });
        }
        if (body.latitude === 1) {
          return response('bad', 500, {
            'x-evroute-failure-code': 'upstream_http',
            'x-evroute-upstream-status': '429',
          });
        }
        if (body.latitude === 2) {
          return response('bad', 500, {
            'x-evroute-failure-code': 'upstream_timeout',
            'x-evroute-upstream-status': '504',
          });
        }
        return response(validMarkers, 200, {
          'x-evroute-failure-code': 'upstream_http',
          'x-evroute-upstream-status': '429',
        });
      },
      collector,
      { retries: 0, budget: new UpstreamBudget(8) },
    );
    const results = await Promise.allSettled([
      client.markers(1, 1, undefined, { endpointClass: 'stations/markers', phase: 'scan', sampleOrdinal: 1 }),
      client.markers(2, 2, undefined, { endpointClass: 'stations/markers', phase: 'scan', sampleOrdinal: 2 }),
      client.detailsWithMeta(99, undefined, { endpointClass: 'stations/details', phase: 'details' }),
      client.markers(3, 3, undefined, { endpointClass: 'stations/markers', phase: 'scan', sampleOrdinal: 4 }),
    ]);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(results.some((result) => result.status === 'rejected')).toBe(true);

    const records = collector.snapshot().failures;
    const sample = (ordinal: number) => records.find((record) => record.sampleOrdinal === ordinal);
    expect(sample(1)).toMatchObject({
      endpointClass: 'stations/markers', code: 'http_5xx', httpStatus: 500,
      gatewayFailureCode: 'upstream_http', gatewayUpstreamStatus: 429,
    });
    expect(sample(2)).toMatchObject({
      endpointClass: 'stations/markers', code: 'http_5xx', httpStatus: 500,
      gatewayFailureCode: 'upstream_timeout', gatewayUpstreamStatus: 504,
    });
    expect(sample(4)).toBeUndefined();
    const detailRecord = records.find((record) => record.endpointClass === 'stations/details');
    expect(detailRecord).toMatchObject({
      code: 'http_400', gatewayFailureCode: null, gatewayUpstreamStatus: null,
    });
  });

  it('reads contract labels only on failed upstream_contract marker responses', async () => {
    const collector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const contractHeaders = {
      'x-evroute-failure-code': 'upstream_contract',
      'x-evroute-upstream-status': '200',
      'x-evroute-contract-reason': 'success_false',
      'x-evroute-contract-data': 'stations_empty',
    };
    const contractClient = clientWith(
      async () => response('bad', 422, contractHeaders),
      collector,
      { retries: 0, budget: new UpstreamBudget(2) },
    );
    await expect(contractClient.markers(0, 0)).rejects.toThrow();
    expect(collector.snapshot().failures[0]).toMatchObject({
      endpointClass: 'stations/markers', code: 'http_4xx_other', httpStatus: 422,
      gatewayFailureCode: 'upstream_contract', gatewayUpstreamStatus: 200,
      gatewayContractReason: 'success_false', gatewayContractData: 'stations_empty',
    });

    const otherCollector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const otherClient = clientWith(
      async () => response('bad', 500, {
        'x-evroute-failure-code': 'upstream_http',
        'x-evroute-upstream-status': '429',
        'x-evroute-contract-reason': 'success_false',
        'x-evroute-contract-data': 'stations_empty',
      }),
      otherCollector,
      { retries: 0, budget: new UpstreamBudget(2) },
    );
    await expect(otherClient.markers(0, 0)).rejects.toThrow();
    expect(otherCollector.snapshot().failures[0]).toMatchObject({
      gatewayFailureCode: 'upstream_http', gatewayUpstreamStatus: 429,
      gatewayContractReason: null, gatewayContractData: null,
    });

    const detailCollector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const detailClient = clientWith(
      async () => response('bad', 422, contractHeaders),
      detailCollector,
      { retries: 0, budget: new UpstreamBudget(2) },
    );
    await expect(detailClient.detailsWithMeta(1)).rejects.toThrow();
    expect(detailCollector.snapshot().failures[0]).toMatchObject({
      endpointClass: 'stations/details', gatewayFailureCode: null,
      gatewayContractReason: null, gatewayContractData: null,
    });
  });

  it('keeps concurrent contract headers isolated and neutralizes header faults', async () => {
    const collector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const client = clientWith(
      async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (body.latitude === 1) {
          return response('bad', 422, {
            'x-evroute-failure-code': 'upstream_contract',
            'x-evroute-upstream-status': '200',
            'x-evroute-contract-reason': 'success_false',
            'x-evroute-contract-data': 'stations_empty',
          });
        }
        if (body.latitude === 2) {
          return response('bad', 422, {
            'x-evroute-failure-code': 'upstream_contract',
            'x-evroute-upstream-status': '200',
            'x-evroute-contract-reason': ' STATIONS_EMPTY',
            'x-evroute-contract-data': 'stations_nonempty',
          });
        }
        return response('{"ok":true,"live":true,"retained":false,"source":"x","count":0,"stations":[]}', 200, {
          'x-evroute-failure-code': 'upstream_contract',
          'x-evroute-contract-reason': 'success_false',
          'x-evroute-contract-data': 'stations_empty',
        });
      },
      collector,
      { retries: 0, budget: new UpstreamBudget(6) },
    );
    // Success uses a distinct client with no collector so it cannot spoof a record.
    const successCollector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const successClient = clientWith(
      async () => response('{"ok":true,"live":true,"retained":false,"source":"x","count":0,"stations":[]}', 200, {
        'x-evroute-failure-code': 'upstream_contract',
        'x-evroute-contract-reason': 'success_false',
        'x-evroute-contract-data': 'stations_empty',
      }),
      successCollector,
      { budget: new UpstreamBudget(2) },
    );

    await Promise.allSettled([
      client.markers(1, 1, undefined, { endpointClass: 'stations/markers', phase: 'scan', sampleOrdinal: 1 }),
      client.markers(2, 2, undefined, { endpointClass: 'stations/markers', phase: 'scan', sampleOrdinal: 2 }),
      successClient.markers(3, 3),
    ]);
    const records = collector.snapshot().failures;
    expect(records.find((r) => r.sampleOrdinal === 1)).toMatchObject({
      gatewayContractReason: 'success_false', gatewayContractData: 'stations_empty',
    });
    expect(records.find((r) => r.sampleOrdinal === 2)).toMatchObject({
      gatewayContractReason: null, gatewayContractData: 'stations_nonempty',
    });
    expect(successCollector.snapshot().failures).toHaveLength(0);

    const hostileCollector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const hostile = clientWith(
      async () => ({
        ok: false,
        status: 422,
        headers: {
          get(name: string) {
            if (name === 'x-evroute-contract-reason') throw new Error('reason trap');
            if (name === 'x-evroute-contract-data') return 'stations_empty';
            if (name === 'x-evroute-failure-code') return 'upstream_contract';
            if (name === 'x-evroute-upstream-status') return '200';
            return null;
          },
        },
        text: async () => 'bad',
      } as unknown as Response),
      hostileCollector,
      { retries: 0, budget: new UpstreamBudget(2) },
    );
    await expect(hostile.markers(0, 0)).rejects.toThrow();
    expect(hostileCollector.snapshot().failures[0]).toMatchObject({
      gatewayFailureCode: 'upstream_contract', gatewayUpstreamStatus: 200,
      gatewayContractReason: null, gatewayContractData: 'stations_empty',
    });
  });
});
