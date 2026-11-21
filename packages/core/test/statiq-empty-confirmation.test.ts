import { describe, expect, it } from 'vitest';
import {
  StatiqAbortError,
  StatiqApiError,
  StatiqClient,
  StatiqRunFatalError,
  type UpstreamAuditEntry,
} from '../src/statiq.js';
import { UpstreamBudget, UpstreamRunStoppedError } from '../src/upstream-budget.js';
import type { StatiqMarkersResponse } from '../src/types.js';
const NORMALIZED_PATH = '/stations/markers';
const RAW_PATH = '/station/v1/markers';
const RAW_URL = 'https://harrier-evroute.aaravnirajsingh.workers.dev/station/v1/markers';
const LAT = 28.6, LON = 77.2;
const VERTICES = [
  [LON - 0.1, LAT - 0.1], [LON + 0.1, LAT - 0.1],
  [LON + 0.1, LAT + 0.1], [LON - 0.1, LAT + 0.1],
  [LON - 0.1, LAT - 0.1],
];
const NORMALIZED_BODY = { latitude: LAT, longitude: LON, vertices: VERTICES };
const RAW_BODY = { latitude: LAT, longitude: LON, all_chargers: 0, connector_id: [], vertices: VERTICES };
const DIAGNOSTIC_HEADERS = {
  'content-type': 'application/json',
  'x-evroute-failure-code': 'upstream_contract',
  'x-evroute-upstream-status': '200',
  'x-evroute-contract-reason': 'success_false',
  'x-evroute-contract-data': 'stations_empty',
};
const RAW_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-evroute-upstream': 'statiq-live',
};
const RAW_EMPTY_BODY = {
  meta: { status_code: 1001, success: false, message: 'No stations found with selected filters' },
  data: { stations: [] },
};
const NONEMPTY_MARKERS: StatiqMarkersResponse = {
  ok: true, live: true, retained: false, source: 'fixture', count: 1,
  stations: [{ stationId: 7, name: 'Fixture', lat: LAT, lon: LON, address: null,
    accessType: 1, isCommunityListed: false, stationUrl: '' }],
};
interface Reply {
  path?: string;
  body?: unknown;
  rawBody?: string;
  status: number;
  headers?: Record<string, string>;
  abort?: () => void;
}
interface Harness {
  client: StatiqClient;
  budget: UpstreamBudget;
  calls: Array<{ url: string; body: unknown }>;
  audit: UpstreamAuditEntry[];
  dispatchTimes: number[];
}
function makeHarness(opts: {
  replies: Reply[];
  maxAttempts?: number;
  minCallGapMs?: number;
  baseUrl?: string;
  withClock?: boolean;
}): Harness {
  const calls: Harness['calls'] = [];
  const audit: UpstreamAuditEntry[] = [];
  const dispatchTimes: number[] = [];
  let nowMs = 0;
  const transport = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const hit = opts.replies[calls.length];
    if (!hit) throw new Error('Unexpected extra upstream request');
    const body = JSON.parse(String(init?.body ?? '{}')) as unknown;
    calls.push({ url: String(url), body });
    dispatchTimes.push(nowMs);
    hit.abort?.();
    const text = hit.rawBody ?? JSON.stringify(hit.body ?? {});
    return new Response(text, { status: hit.status, headers: new Headers(hit.headers ?? {}) });
  }) as typeof fetch;
  const client = new StatiqClient({
    token: 'fixture-token',
    baseUrl: opts.baseUrl ?? 'https://harrier-evroute.aaravnirajsingh.workers.dev/api',
    fetchImpl: transport,
    onUpstreamCall: entry => audit.push(entry),
    retries: 0,
    minCallGapMs: opts.minCallGapMs ?? 0,
    maxCallsPerMinute: 1_000,
    ...(opts.withClock
      ? { now: () => nowMs, sleepImpl: async (ms: number) => { nowMs += Math.max(0, ms); } }
      : {}),
  });
  const budget = new UpstreamBudget(opts.maxAttempts ?? 10);
  client.attachRunBudget(budget);
  return { client, budget, calls, audit, dispatchTimes };
}
function normalizedError(overrides: Record<string, string> = {}): Reply {
  return { body: { error: 'contract' }, status: 400,
    headers: { ...DIAGNOSTIC_HEADERS, ...overrides } };
}
describe('raw empty-marker confirmation', () => {
  it('confirms the exact no-results raw contract with two audited transports', async () => {
    const h = makeHarness({ replies: [
      { path: NORMALIZED_PATH, ...normalizedError() },
      { path: RAW_PATH, body: RAW_EMPTY_BODY, status: 200, headers: RAW_HEADERS },
    ] });
    const result = await h.client.markers(LAT, LON);
    expect(result).toEqual({
      ok: true, live: true, retained: false, source: 'raw-confirmed-empty', count: 0, stations: [],
    });
    expect(h.calls.map(c => c.url)).toEqual([
      'https://harrier-evroute.aaravnirajsingh.workers.dev/api' + NORMALIZED_PATH, RAW_URL,
    ]);
    expect(h.calls.map(c => c.body)).toEqual([NORMALIZED_BODY, RAW_BODY]);
    expect(h.audit.map(a => a.status)).toEqual([400, 200]);
    expect(h.budget.attemptsMade).toBe(2);
    expect(h.client.dispatchedAttemptsMade()).toBe(2);
  });
  it('honors the default two-second gap between normalized and raw transports', async () => {
    const h = makeHarness({ withClock: true, minCallGapMs: 2_000, replies: [
      { path: NORMALIZED_PATH, ...normalizedError() },
      { path: RAW_PATH, body: RAW_EMPTY_BODY, status: 200, headers: RAW_HEADERS },
    ] });
    await h.client.markers(LAT, LON);
    expect(h.calls).toHaveLength(2);
    expect((h.dispatchTimes[1] as number) - (h.dispatchTimes[0] as number)).toBeGreaterThanOrEqual(2_000);
    expect(h.budget.attemptsMade).toBe(2);
  });
  const normalizedFailures = [
    { name: 'missing data label', reply: normalizedError({ 'x-evroute-contract-data': '' }) },
    { name: 'wrong data label', reply: normalizedError({ 'x-evroute-contract-data': 'stations_nonempty' }) },
    { name: 'wrong status', reply: { path: NORMALIZED_PATH, body: {}, status: 422, headers: DIAGNOSTIC_HEADERS } },
    { name: 'auth', reply: { path: NORMALIZED_PATH, body: 'forbidden', status: 403, headers: DIAGNOSTIC_HEADERS } },
    { name: 'throttle', reply: { path: NORMALIZED_PATH, body: 'slow down', status: 429, headers: DIAGNOSTIC_HEADERS } },
    { name: 'upstream 500', reply: { path: NORMALIZED_PATH, body: 'boom', status: 500, headers: DIAGNOSTIC_HEADERS } },
  ];
  it.each(normalizedFailures)('does not probe raw for normalized $name', async ({ reply }) => {
    const h = makeHarness({ replies: [reply] });
    const error = await h.client.markers(LAT, LON).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(h.calls).toHaveLength(1);
    expect(h.budget.attemptsMade).toBe(1);
  });
  const rawFailures = [
    { name: 'wrong status_code 1000', body: { meta: { status_code: 1000, success: false, message: 'No stations found with selected filters' }, data: { stations: [] } } },
    { name: 'wrong status_code 2000', body: { meta: { status_code: 2000, success: false, message: 'No stations found with selected filters' }, data: { stations: [] } } },
    { name: 'wrong status_code 3001', body: { meta: { status_code: 3001, success: false, message: 'No stations found with selected filters' }, data: { stations: [] } } },
    { name: 'success true', body: { meta: { status_code: 1001, success: true, message: 'No stations found with selected filters' }, data: { stations: [] } } },
    { name: 'wrong message', body: { meta: { status_code: 1001, success: false, message: 'No stations found' }, data: { stations: [] } } },
    { name: 'absent meta', body: { data: { stations: [] } } },
    { name: 'non-empty stations', body: { meta: { status_code: 1001, success: false, message: 'No stations found with selected filters' }, data: { stations: [{}] } } },
    { name: 'malformed body', rawBody: 'not-json' },
    { name: 'text content type', body: RAW_EMPTY_BODY, headers: { ...RAW_HEADERS, 'content-type': 'text/plain' } },
    { name: 'no no-store', body: RAW_EMPTY_BODY, headers: { ...RAW_HEADERS, 'cache-control': 'max-age=30' } },
    { name: 'wrong upstream header', body: RAW_EMPTY_BODY, headers: { ...RAW_HEADERS, 'x-evroute-upstream': 'retained' } },
    { name: 'conflicting live', body: { ...RAW_EMPTY_BODY, live: false } },
    { name: 'conflicting retained', body: { ...RAW_EMPTY_BODY, retained: true } },
  ];
  it.each(rawFailures)('keeps the original failure for raw $name', async ({ body, rawBody, headers }) => {
    const h = makeHarness({ replies: [
      { path: NORMALIZED_PATH, ...normalizedError() },
      { path: RAW_PATH, body, rawBody, status: 200, headers: headers ?? RAW_HEADERS },
    ] });
    const error = await h.client.markers(LAT, LON).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(StatiqApiError);
    expect(h.calls).toHaveLength(2);
    expect(h.budget.attemptsMade).toBe(2);
  });
  it('never sends the raw fallback to a custom base host', async () => {
    const h = makeHarness({ baseUrl: 'https://custom.test/api', replies: [normalizedError()] });
    const error = await h.client.markers(LAT, LON).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(StatiqApiError);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url).toBe('https://custom.test/api' + NORMALIZED_PATH);
    expect(h.calls.some(c => c.url.includes('harrier-evroute'))).toBe(false);
  });
  it('refuses raw confirmation when the run budget is exhausted', async () => {
    const h = makeHarness({ maxAttempts: 1, replies: [normalizedError()] });
    const error = await h.client.markers(LAT, LON).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(UpstreamRunStoppedError);
    expect(h.calls).toHaveLength(1);
    expect(h.budget.attemptsMade).toBe(1);
  });
  it('does not start raw confirmation after cancellation', async () => {
    const outer = new AbortController();
    const h = makeHarness({ replies: [{ ...normalizedError(), abort: () => outer.abort() }] });
    const error = await h.client.markers(LAT, LON, outer.signal).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(StatiqAbortError);
    expect(h.calls).toHaveLength(1);
    expect(h.budget.attemptsMade).toBe(1);
  });
  const rawHardFailures = [
    { name: 'auth 401', status: 401, type: StatiqRunFatalError },
    { name: 'auth 403', status: 403, type: StatiqRunFatalError },
    { name: 'throttle 429', status: 429, type: StatiqRunFatalError },
    { name: 'upstream 500', status: 500, type: StatiqApiError },
  ];
  it.each(rawHardFailures)('propagates raw $name without an empty result', async ({ status, type }) => {
    const h = makeHarness({ replies: [
      normalizedError(),
      { path: RAW_PATH, body: { error: 'hard failure' }, status, headers: RAW_HEADERS },
    ] });
    const error = await h.client.markers(LAT, LON).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(type);
    expect(h.calls).toHaveLength(2);
    expect(h.budget.attemptsMade).toBe(2);
    if (status === 401 || status === 403 || status === 429) {
      expect(h.budget.stopped).toBe(status === 429 ? 'throttled' : 'auth');
    }
  });
  it('keeps one-transport normalized nonempty behavior', async () => {
    const h = makeHarness({ replies: [{ path: NORMALIZED_PATH, body: NONEMPTY_MARKERS, status: 200, headers: { 'content-type': 'application/json' } }] });
    const result = await h.client.markers(LAT, LON);
    expect(result).toEqual(NONEMPTY_MARKERS);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.body).toEqual(NORMALIZED_BODY);
    expect(h.budget.attemptsMade).toBe(1);
  });
});