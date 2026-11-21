/**
 * REAL StatiqClient with explicit bulk opt-in over a wire-shaped fake bulk
 * transport. Complements legacy-wire harnesses (which now use legacy paths):
 * proves the deployed bulk path is exercised through planTrip, with honest
 * fetch counts, cancellation and fail-closed behavior.
 */
import { describe, expect, it } from 'vitest';
import { OsrmRouter } from '../src/router.js';
import { planTrip } from '../src/planner.js';
import { StatiqClient, type UpstreamAuditEntry } from '../src/statiq.js';
import { UpstreamBudget } from '../src/upstream-budget.js';

const KM_PER_DEG = 111.32;
const NOW = '2026-11-21T10:00:00.000Z';
const LATER = '2026-11-21T10:00:01.000Z';

interface Want { abortOnMarkers?: boolean; throttleMarkers?: boolean; }

function harness(want: Want = {}) {
  let bulkCalls = 0, legacyCalls = 0;
  const audit: UpstreamAuditEntry[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    const target = String(url);
    if (target.endsWith('/stations/markers-bulk')) {
      bulkCalls++;
      if (want.throttleMarkers) {
        return new Response(JSON.stringify({ ok: false, error: { code: 'throttled' }, upstreamAttempts: 0 }),
          { status: 429, headers: { 'retry-after': '30' } });
      }
      const body = JSON.parse(init.body);
      const squares = body.squares as Array<{ key: string; latitude: number; longitude: number; vertices: number[][] }>;
      const near = (latitude: number): boolean => Math.abs(latitude * KM_PER_DEG - 150) <= 13;
      const items = squares.map((s) => {
        const isNear = near(s.latitude);
        return {
          key: s.key, latitude: s.latitude, longitude: s.longitude, vertices: s.vertices,
          outcome: isNear ? 'ok' : 'confirmed-empty', reason: null,
          upstream: { attempts: 1, statuses: [200], fetchedAt: LATER },
          provenance: { sourceUrlPath: '/station/v1/markers', httpStatus: 200,
            contentType: 'application/json', cacheControl: null },
          data: isNear ? {
            source: 'Statiq station markers (live)', count: 1,
            stations: [{ stationId: 1, name: 'Fixture station', lat: 150 / KM_PER_DEG, lon: 0,
              address: null, accessType: 1, isCommunityListed: false, stationUrl: '' }],
          } : null,
          ...(isNear ? {} : {
            confirmation: { sourceUrlPath: '/station/v1/markers', httpStatus: 200,
              contentType: 'application/json', cacheControl: null, fetchedAt: LATER,
              statusCode: 1001, success: false, message: 'No stations found with selected filters', stationsCount: 0 },
          }),
        };
      });
      if (want.abortOnMarkers) {
        // Late success after the run deadline must NOT count as coverage.
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      return new Response(JSON.stringify({
        ok: items.every((i) => i.outcome === 'ok' || i.outcome === 'confirmed-empty'),
        live: true, retained: false, endpoint: 'markers-bulk',
        startedAt: NOW, completedAt: LATER, deadline: { ms: 150000, hit: false },
        requestedItems: items.length, attemptedItems: items.length, completedItems: items.length,
        upstreamAttempts: items.length, upstreamByStatus: { '200': items.length }, items,
      }), { status: 200, headers: {
        'content-type': 'application/json', 'cache-control': 'no-store',
        'x-evroute-upstream': 'statiq-live',
      } });
    }
    if (target.endsWith('/stations/details-bulk')) {
      bulkCalls++;
      const body = JSON.parse(init.body);
      const stations = body.stations as Array<{ key: string; stationId: number }>;
      const items = stations.map((s) => ({
        key: s.key, stationId: s.stationId, outcome: 'ok', reason: null,
        upstream: { attempts: 1, statuses: [200], fetchedAt: LATER },
        provenance: { sourceUrlPath: '/station/v1/details', httpStatus: 200,
          contentType: 'application/json', cacheControl: null },
        data: { source: 'Statiq station detail (live)', station: {
          stationId: s.stationId, name: 'Fixture station', lat: 150 / KM_PER_DEG, lon: 0,
          address: null, area: null, city: null, landmark: null, hours: null, openText: null,
          rating: null, reviewCount: null, accessType: 'public', navUrl: '', stationUrl: '',
          imageUrl: null, amenities: [], stepsToReach: null,
          chargers: [{ chargerId: 11, name: 'DC', type: 'DC', kw: 60, pricePerKwh: 20,
            currency: 'INR', lastUsedOn: null, connectors: [{ displayId: 1, connectorId: 101,
              type: 'CCS-2', status: 'available', available: true, note: null }] }],
          summary: { anyDc: true, ccs2Dc: true, maxDcCcs2Kw: 60, availableNow: true, statusCounts: {} },
        } },
      }));
      return new Response(JSON.stringify({
        ok: true, live: true, retained: false, endpoint: 'details-bulk',
        startedAt: NOW, completedAt: LATER, deadline: { ms: 150000, hit: false },
        requestedItems: items.length, attemptedItems: items.length, completedItems: items.length,
        upstreamAttempts: items.length, upstreamByStatus: { '200': items.length }, items,
      }), { status: 200, headers: {
        'content-type': 'application/json', 'cache-control': 'no-store',
        'x-evroute-upstream': 'statiq-live',
      } });
    }
    legacyCalls++;
    return new Response(JSON.stringify({ ok: true, stations: [], count: 0 }));
  }) as typeof fetch;
  const client = new StatiqClient({
    token: 'offline-only', baseUrl: 'https://worker.test/api', fetchImpl, bulk: true,
    minCallGapMs: 1, maxCallsPerMinute: 10000, retries: 0,
    runDeadlineAt: Date.now() + 60000, onUpstreamCall: (e) => audit.push(e),
  });
  client.attachRunBudget(new UpstreamBudget(200));
  const router = { route: async () => ({
    distanceKm: 200, durationMin: 200,
    geometry: Array.from({ length: 21 }, (_, i) => ({ lat: (200 / KM_PER_DEG) * (i / 20), lon: 0 })),
  }) } as unknown as OsrmRouter);
  return { client, router, audit, bulkCalls: () => bulkCalls, legacyCalls: () => legacyCalls };
}

const O = { label: 'Origin', lat: 0, lon: 0 };
const D = { label: 'Destination', lat: 200 / KM_PER_DEG, lon: 0 };
const opts = { startSocPct: 50 };

describe('real bulk wire path', () => {
  it('uses bulk endpoints only and plans from verified bulk candidates', async () => {
    const h = harness();
    const plan = await planTrip({ router: h.router, statiq: h.client }, O, D, opts);
    expect(plan.stops).toHaveLength(1);
    expect(h.bulkCalls()).toBeGreaterThan(0);
    expect(h.legacyCalls()).toBe(0);
    expect(h.audit.length).toBeGreaterThan(0);
    expect(h.audit.every((e) => e.status === 200)).toBe(true);
  });

  it('bulk capability is explicit: injected transport without opt-in stays legacy', async () => {
    const plain = new StatiqClient({ token: 'offline-only', baseUrl: 'https://worker.test/api',
      fetchImpl: (async () => new Response(JSON.stringify({ ok: true, stations: [], count: 0 }))) as typeof fetch });
    expect(plain.bulkSupported()).toBe(false);
    const opted = new StatiqClient({ token: 'offline-only', baseUrl: 'https://worker.test/api',
      fetchImpl: (async () => new Response('{}')) as typeof fetch, bulk: true });
    expect(opted.bulkSupported()).toBe(true);
  });

  it('a late bulk marker success after deadline does not become fresh coverage', async () => {
    const h = harness({ abortOnMarkers: true });
    const err = await planTrip({ router: h.router, statiq: h.client }, O, D,
      { ...opts, runBudget: { deadlineMs: 20, maxUpstreamCalls: 200 } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toContain('not determined');
    expect(message).toContain('route samples covered 0/');
  });

  it('bulk whole-call throttle fails closed without legacy fallback', async () => {
    const h = harness({ throttleMarkers: true });
    const err = await planTrip({ router: h.router, statiq: h.client }, O, D, opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toContain('throttl');
    expect(h.legacyCalls()).toBe(0);
  });
});
