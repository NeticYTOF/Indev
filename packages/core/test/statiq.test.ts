import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatiqApiError, StatiqClient } from '../src/statiq.js';
import type { StatiqDetailsResponse, StatiqMarkersResponse } from '../src/types.js';

const TOKEN = 'test-token-abc123';

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
    const client = new StatiqClient({ token: TOKEN, baseUrl: 'https://example.test/api', fetchImpl: impl });
    const res = await client.markers(28.6, 77.2);
    expect(res.stations[0]?.stationId).toBe(1790);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://example.test/api/stations/markers');
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ latitude: 28.6, longitude: 77.2 });
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
    const client = new StatiqClient({ token: TOKEN, baseUrl: 'https://example.test/api', fetchImpl: impl });
    await client.details(1790);
    await client.details(1790);
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
    const client = new StatiqClient({ token: TOKEN, baseUrl: 'https://example.test/api', fetchImpl: impl });
    const res = await client.details(1790);
    expect(res.station?.stationId).toBe(1790);
    expect(calls).toHaveLength(2);
  });

  it('does not retry 404 and throws without leaking the token', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 404, body: '{"error":"Not found"}' }));
    const client = new StatiqClient({ token: TOKEN, baseUrl: 'https://example.test/api', fetchImpl: impl });
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
    });
    await expect(client.markers(1, 1)).rejects.toThrow(StatiqApiError);
    expect(calls).toHaveLength(2); // initial + 1 retry
  });

  it('requires a token', () => {
    expect(() => new StatiqClient({ token: '' })).toThrow(/STATIQ_API_TOKEN/);
  });
});
