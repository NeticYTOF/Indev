import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatiqAbortError, StatiqApiError, StatiqClient, type UpstreamAuditEntry } from '../src/statiq.js';
import type { StatiqDetailsResponse, StatiqMarkersResponse } from '../src/types.js';

const TOKEN = 'test-token-abc123';
/** Limiter-friendly settings so these tests don't wait real seconds. */
const FAST = { minCallGapMs: 1, maxCallsPerMinute: 1_000 } as const;

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function fakeFetch(responder: (call: Call) => { status: number; body: string } | Promise<{ status: number; body: string }>) {
  const calls: Call[] = [];
  const impl = async (url: unknown, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: String(init?.body ?? ''),
    };
    calls.push(call);
    const { status, body } = await responder(call);
    return new Response(body, { status });
  };
  return { impl, calls };
}

const markersResponse: StatiqMarkersResponse = {
  ok: true,
  live: true,
  retained: false,
  source: 'test',
  count: 1,
  stations: [
    {
      stationId: 1790,
      name: 'Statiq Hotel The Suryaa Station',
      lat: 28.561199,
      lon: 77.269501,
      address: null,
      accessType: 1,
      isCommunityListed: false,
      stationUrl: 'https://www.statiq.in/x',
    },
  ],
};

const detailsResponse: StatiqDetailsResponse = {
  ok: true,
  live: true,
  retained: false,
  source: 'test',
  station: {
    stationId: 1790,
    name: 'Statiq Hotel The Suryaa Station',
    lat: 28.561199,
    lon: 77.269501,
    address: null,
    area: null,
    city: 'New Delhi',
    landmark: null,
    hours: '00:00 To 23:59',
    openText: 'Open Now',
    rating: 4.72,
    reviewCount: 4774,
    accessType: 'public',
    navUrl: 'x',
    stationUrl: 'x',
    imageUrl: null,
    amenities: [],
    stepsToReach: null,
    chargers: [],
    summary: null,
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StatiqClient', () => {
  it('sends the bearer token and parses markers', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: JSON.stringify(markersResponse) }));
    const client = new StatiqClient({ token: TOKEN, baseUrl: 'https://example.test/api', fetchImpl: impl, ...FAST });
    const lat = 28.6, lon = 77.2;
    const res = await client.markers(lat, lon);
    expect(res.stations[0]?.stationId).toBe(1790);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://example.test/api/stations/markers');
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
      latitude: lat,
      longitude: lon,
      vertices: [
        [lon - 0.1, lat - 0.1], [lon + 0.1, lat - 0.1],
        [lon + 0.1, lat + 0.1], [lon - 0.1, lat + 0.1],
        [lon - 0.1, lat - 0.1],
      ],
    });
  });

  it('caches details within the TTL and re-fetches after it', async () => {
    let count = 0;
    const { impl, calls } = fakeFetch(() => {
      count++;
      return { status: 200, body: JSON.stringify(detailsResponse) };
    });
    const client = new StatiqClient({
      token: TOKEN,
      baseUrl: 'https://example.test/api',
      fetchImpl: impl,
      cacheTtlMs: 10,
      ...FAST,
    });
    await client.details(1790);
    await client.details(1790);
    expect(calls).toHaveLength(1); // cached
    await new Promise((r) => setTimeout(r, 25));
    await client.details(1790);
    expect(calls).toHaveLength(2); // TTL expired
    expect(count).toBe(2);
  });

  it('does not cache failed lookups (station null)', async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      body: JSON.stringify({ ok: false, live: false, retained: true, source: 'test', station: null }),
    }));
    const client = new StatiqClient({ token: TOKEN, baseUrl: 'https://example.test/api', fetchImpl: impl, ...FAST });
    await expect(client.details(1790)).rejects.toBeInstanceOf(StatiqApiError);
    await expect(client.details(1790)).rejects.toBeInstanceOf(StatiqApiError);
    expect(calls).toHaveLength(2);
  });

  it('retries 5xx then succeeds', async () => {
    let n = 0;
    const { impl, calls } = fakeFetch(() => {
      n++;
      return n === 1
        ? { status: 502, body: '{"error":"bad gateway"}' }
        : { status: 200, body: JSON.stringify(detailsResponse) };
    });
    const client = new StatiqClient({ token: TOKEN, baseUrl: 'https://example.test/api', fetchImpl: impl, ...FAST });
    const res = await client.details(1790);
    expect(res.station?.stationId).toBe(1790);
    expect(calls).toHaveLength(2);
  });

  it('does not retry 404 and throws without leaking the token', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 404, body: '{"error":"Not found"}' }));
    const client = new StatiqClient({ token: TOKEN, baseUrl: 'https://example.test/api', fetchImpl: impl, ...FAST });
    await expect(client.details(1)).rejects.toBeInstanceOf(StatiqApiError);
    expect(calls).toHaveLength(1);
    try {
      await client.details(1);
    } catch (err) {
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });

  it('throws after exhausting retries on persistent 500s', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 500, body: '{"error":"boom"}' }));
    const client = new StatiqClient({
      token: TOKEN,
      baseUrl: 'https://example.test/api',
      fetchImpl: impl,
      retries: 1,
      ...FAST,
    });
    await expect(client.markers(1, 1)).rejects.toThrow(StatiqApiError);
    expect(calls).toHaveLength(2); // initial + 1 retry
  });

  it('requires a token', () => {
    expect(() => new StatiqClient({ token: '' })).toThrow(/STATIQ_API_TOKEN/);
  });
});

/** Deterministic harness: fake clock + recording transport. */
function deterministicClient(
  opts: {
    respond?: (call: { n: number; attempt: number }) => {
      status: number;
      body?: string;
      headers?: Record<string, string>;
    };
    maxCallsPerMinute?: number;
    minCallGapMs?: number;
    retries?: number;
    onUpstreamCall?: (entry: UpstreamAuditEntry) => void;
  } = {},
) {
  let nowMs = 0;
  const transportTimes: number[] = [];
  let call = 0;
  const transport = (async (_url: unknown, init?: RequestInit) => {
    const n = call++;
    transportTimes.push(nowMs);
    const r = opts.respond?.({ n, attempt: 0 }) ?? { status: 200, body: JSON.stringify(emptyMarkers) };
    const body =
      r.body ?? JSON.stringify({ ok: true, live: true, retained: false, source: 't', count: 0, stations: [] } as StatiqMarkersResponse);
    const headers = new Headers(r.headers ?? {});
    void init;
    return new Response(body, { status: r.status, headers });
  }) as typeof fetch;
  const sleepImpl = async (ms: number) => {
    nowMs += Math.max(0, ms); // sleeping advances the fake clock deterministically
  };
  const client = new StatiqClient({
    token: 't',
    baseUrl: 'https://x.test/api',
    fetchImpl: transport,
    now: () => nowMs,
    sleepImpl,
    retries: opts.retries ?? 0,
    ...(opts.maxCallsPerMinute ? { maxCallsPerMinute: opts.maxCallsPerMinute } : {}),
    ...(opts.minCallGapMs ? { minCallGapMs: opts.minCallGapMs } : {}),
    ...(opts.onUpstreamCall ? { onUpstreamCall: opts.onUpstreamCall } : {}),
  });
  return { client, transportTimes, now: () => nowMs };
}

const emptyMarkers: StatiqMarkersResponse = {
  ok: true,
  live: true,
  retained: false,
  source: 't',
  count: 0,
  stations: [],
};

describe('rate limiter (mocked transport + mocked clock)', () => {
  it('enforces the minimum gap even when requests burst in concurrently', async () => {
    const { client, transportTimes } = deterministicClient({ minCallGapMs: 2000 });
    await Promise.all(Array.from({ length: 12 }, (_, i) => client.markers(1 + i, 1)));
    expect(transportTimes).toHaveLength(12);
    for (let i = 1; i < transportTimes.length; i++) {
      const gap = (transportTimes[i] as number) - (transportTimes[i - 1] as number);
      expect(gap).toBeGreaterThanOrEqual(2000);
    }
  });

  it('never exceeds maxCallsPerMinute in any rolling 60s window', async () => {
    const { client, transportTimes } = deterministicClient({
      maxCallsPerMinute: 5,
      minCallGapMs: 100, // gap allows bursts; the window cap must stop them
    });
    await Promise.all(Array.from({ length: 16 }, (_, i) => client.markers(1 + i, 1)));
    expect(transportTimes.length).toBe(16);
    for (let i = 0; i < transportTimes.length; i++) {
      const t = transportTimes[i] as number;
      const inWindow = transportTimes.filter((x) => x >= t - 59_999 && x <= t);
      expect(inWindow.length).toBeLessThanOrEqual(5);
    }
  });

  it('honors Retry-After seconds on 429 before retrying', async () => {
    let n = 0;
    const { client, transportTimes } = deterministicClient({
      retries: 2,
      respond: () => {
        n++;
        if (n === 1) {
          return { status: 429, body: '{"error":"Please wait a minute."}', headers: { 'Retry-After': '30' } };
        }
        return { status: 200 };
      },
    });
    await client.markers(1, 1);
    expect(transportTimes).toHaveLength(2);
    // second attempt must wait >= 30s of clock time after the first
    expect((transportTimes[1] as number) - (transportTimes[0] as number)).toBeGreaterThanOrEqual(30_000);
  });

  it('propagates aborts immediately instead of retrying or waiting', async () => {
    // saturate the window so the next call has to wait in acquireSlot
    const { client, transportTimes } = deterministicClient({
      maxCallsPerMinute: 2,
      minCallGapMs: 1,
    });
    await client.markers(1, 1);
    await client.markers(2, 2);
    const controller = new AbortController();
    controller.abort();
    await expect(client.markers(3, 3, controller.signal)).rejects.toBeInstanceOf(StatiqAbortError);
    expect(transportTimes).toHaveLength(2); // no third call was made
  });

  it('caps total attempts at retries and surfaces the last error', async () => {
    const { client, transportTimes } = deterministicClient({
      retries: 2,
      respond: () => ({ status: 500, body: '{"error":"boom"}' }),
    });
    await expect(client.markers(1, 1)).rejects.toBeInstanceOf(StatiqApiError);
    expect(transportTimes).toHaveLength(3); // initial + 2 retries, no tight loop
  });

  it('never truncates a large Retry-After beyond the old 90s cap', async () => {
    let n = 0;
    const { client, transportTimes } = deterministicClient({
      retries: 2,
      respond: () => {
        n++;
        if (n === 1) {
          return { status: 429, body: '{"error":"wait"}', headers: { 'Retry-After': '120' } };
        }
        return { status: 200 };
      },
    });
    await client.markers(1, 1);
    expect(transportTimes).toHaveLength(2);
    // second attempt must wait the FULL 120s (no 90s truncation)
    expect((transportTimes[1] as number) - (transportTimes[0] as number)).toBeGreaterThanOrEqual(120_000);
  });

  it('fails fast as throttled when Retry-After cannot fit before the run deadline', async () => {
    let nowMs = 0;
    const transportTimes: number[] = [];
    let n = 0;
    const transport = (async () => {
      n++;
      transportTimes.push(nowMs);
      if (n === 1) {
        return new Response('{"error":"Please wait a minute."}', { status: 429, headers: { 'Retry-After': '60' } });
      }
      return new Response(JSON.stringify(emptyMarkers), { status: 200 });
    }) as typeof fetch;
    const client = new StatiqClient({
      token: 't',
      baseUrl: 'https://x.test/api',
      fetchImpl: transport,
      now: () => nowMs,
      sleepImpl: async (ms: number) => {
        nowMs += ms;
      },
      retries: 2,
      minCallGapMs: 1,
      maxCallsPerMinute: 1_000,
      runDeadlineAt: 30_000, // only 30s left; server demands 60s
    });
    const err = await client.markers(1, 1).catch((e) => e);
    expect(err).toBeInstanceOf(StatiqApiError);
    expect((err as StatiqApiError).status).toBe(429);
    expect((err as StatiqApiError).retryAfterMs).toBeGreaterThanOrEqual(60_000);
    // no early retry: the throttled error surfaces without a second call
    expect(transportTimes).toHaveLength(1);
  });
});

describe('sanitized audit logging (no private route data)', () => {
  it('emits one entry per attempt with seq, endpoint, status, at - and nothing else', async () => {
    const entries: UpstreamAuditEntry[] = [];
    const { client, transportTimes } = deterministicClient({
      retries: 1,
      respond: ({ n }: { n: number }) =>
        n === 0
          ? { status: 429, body: '{"error":"wait"}', headers: { 'Retry-After': '1' } }
          : { status: 200 },
      onUpstreamCall: (e) => entries.push(e),
    });
    await client.markers(28.6139, 77.209);
    expect(transportTimes).toHaveLength(2);
    expect(entries).toHaveLength(2);
    // strictly sanitized shape
    for (const e of entries) {
      expect(Object.keys(e).sort()).toEqual(['at', 'endpoint', 'seq', 'status']);
      expect(e.endpoint).toBe('stations/markers');
    }
    expect(entries[0]?.status).toBe(429);
    expect(entries[0]?.seq).toBe(1);
    expect(entries[1]?.status).toBe(200);
    expect(entries[1]?.seq).toBe(2);
    expect(Number.isNaN(Date.parse(entries[0]?.at ?? ''))).toBe(false);
    // the sanitized stream contains no coordinates, bodies or token
    const json = JSON.stringify(entries);
    expect(json).not.toContain('28.6139');
    expect(json).not.toContain('77.209');
    expect(json).not.toContain('Authorization');
    expect(json).not.toContain('latitude');
  });

  it('audits transport failures with status 0 (abort path)', async () => {
    const entries: UpstreamAuditEntry[] = [];
    let nowMs = 0;
    const controller = new AbortController();
    const transportTimes: number[] = [];
    const transport = (async () => {
      transportTimes.push(nowMs);
      throw new Error('network down');
    }) as typeof fetch;
    const client = new StatiqClient({
      token: 't',
      baseUrl: 'https://x.test/api',
      fetchImpl: transport,
      now: () => nowMs,
      sleepImpl: async (ms: number) => {
        nowMs += ms;
      },
      retries: 0,
      minCallGapMs: 1,
      maxCallsPerMinute: 1_000,
      onUpstreamCall: (e) => entries.push(e),
    });
    // transport throws (not abort): still audited, with status 0
    const err = await client.markers(1, 1, controller.signal).catch((e) => e);
    void err;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe(0);
    expect(entries[0]?.endpoint).toBe('stations/markers');
    expect(entries[0]?.seq).toBe(1);
    // abort BEFORE the call departs: nothing reached the wire, so nothing
    // new is audited (only real upstream attempts are counted)
    controller.abort();
    await expect(client.markers(2, 2, controller.signal)).rejects.toBeInstanceOf(StatiqAbortError);
    expect(entries).toHaveLength(1);
  });

  it('notices aborts during a long Retry-After wait (abort-aware sleep)', async () => {
    let nowMs = 0;
    const controller = new AbortController();
    const transportTimes: number[] = [];
    const transport = (async () => {
      transportTimes.push(nowMs);
      return new Response('{"error":"wait"}', { status: 429, headers: { 'Retry-After': '600' } });
    }) as typeof fetch;
    const client = new StatiqClient({
      token: 't',
      baseUrl: 'https://x.test/api',
      fetchImpl: transport,
      now: () => nowMs,
      sleepImpl: async (ms: number) => {
        nowMs += ms;
        // an external deadline fires 250ms into the demanded 600s wait
        if (nowMs >= 250 && !controller.signal.aborted) controller.abort();
      },
      retries: 1,
      minCallGapMs: 1,
      maxCallsPerMinute: 1_000,
    });
    const err = await client.markers(1, 1, controller.signal).catch((e) => e);
    expect(err).toBeInstanceOf(StatiqAbortError);
    // no retry happened after the abort
    expect(transportTimes).toHaveLength(1);
    // the fake clock barely advanced past the abort point: cancel noticed fast
    expect(nowMs).toBeLessThan(1_000);
  });
});
