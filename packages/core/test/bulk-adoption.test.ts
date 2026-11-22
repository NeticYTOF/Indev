/**
 * Functional adoption: planTrip uses ordered bulk marker + detail batches
 * when the client supports them; legacy per-call methods are not used.
 * Offline only - no provider calls.
 */
import { describe, expect, it } from 'vitest';
import { planTrip } from '../src/planner.js';
import type { OsrmRouter, RouteResult } from '../src/router.js';
import { StatiqRunFatalError, type StatiqClient, type BulkItemResult, type StationDetailsWithMeta } from '../src/statiq.js';
import type { StatiqStationDetail, StatiqMarkersResponse } from '../src/types.js';
import { endpointRouter } from './support/road-fixture.js';

const KM_PER_DEG = 111.32;
const LATER = new Date('2026-11-21T10:00:01.000Z');

function detail(id: number, km: number): StatiqStationDetail {
  return {
    stationId: id, name: `Bulk ${id}`, lat: km / KM_PER_DEG, lon: 0,
    address: null, area: null, city: null, landmark: null,
    hours: '00:00 To 23:59', openText: 'Open Now', rating: null, reviewCount: null,
    accessType: 'public', navUrl: '', stationUrl: '', imageUrl: null, amenities: [],
    stepsToReach: null,
    chargers: [{ chargerId: id * 10 + 1, name: 'DC', type: 'DC', kw: 60,
      pricePerKwh: 20, currency: 'INR', lastUsedOn: null,
      connectors: [{ displayId: 1, connectorId: id, type: 'CCS-2',
        status: 'available', available: true, note: null }] }],
    summary: { anyDc: true, ccs2Dc: true, maxDcCcs2Kw: 60, availableNow: true, statusCounts: {} },
  };
}

describe('planTrip bulk adoption', () => {
  it('uses one bulk scan and one bulk details batch, never the legacy calls', async () => {
    const km = 150;
    const station = detail(1, km);
    let legacyMarkerCalls = 0;
    let legacyDetailCalls = 0;
    let bulkMarkerCalls = 0;
    let bulkDetailCalls = 0;
    const statiq = {
      markers: async () => { legacyMarkerCalls++; throw new Error('legacy markers'); },
      detailsWithMeta: async () => { legacyDetailCalls++; throw new Error('legacy details'); },
      attachRunBudget: () => {},
      markersBulk: async (points: readonly { lat: number; lon: number }[]) => {
        bulkMarkerCalls++;
        return points.map((p) => {
          const near = Math.abs(p.lat * KM_PER_DEG - km) <= 13;
          return {
            outcome: near ? 'ok' : 'confirmed-empty',
            reason: null,
            upstream: { attempts: 1, statuses: [200], fetchedAt: LATER.toISOString() },
            response: near ? {
              ok: true, live: true, retained: false, source: 'bulk', count: 1,
              stations: [{ stationId: station.stationId, name: station.name, lat: station.lat,
                lon: station.lon, address: null, accessType: 1, isCommunityListed: false, stationUrl: '' }],
            } : { ok: true, live: true, retained: false, source: 'raw-confirmed-empty', count: 0, stations: [] },
          };
        });
      },
      detailsBulk: async (ids: readonly number[]) => {
        bulkDetailCalls++;
        return ids.map((id) => ({
          outcome: 'ok', reason: null,
          upstream: { attempts: 1, statuses: [200], fetchedAt: LATER.toISOString() },
          response: { response: { ok: true, live: true, retained: false,
            source: 'bulk', station: detail(id, km) }, fetchedAt: LATER },
        }));
      },
    } as unknown as StatiqClient;
    const router = endpointRouter();
    // At 50% start the car can reach the 150 km station (~13% left, above the
    // 10% reserve) but cannot finish 200 km (~1% left): one charge is required.
    // Physics is the existing flat-consumption model, unmodified.
    const plan = await planTrip({ router, statiq },
      { label: 'Origin', lat: 0, lon: 0 }, { label: 'Destination', lat: 200 / KM_PER_DEG, lon: 0 },
      { startSocPct: 50 });
    expect(plan.stops).toHaveLength(1);
    expect(bulkMarkerCalls).toBeGreaterThan(0);
    expect(bulkDetailCalls).toBe(1);
    expect(legacyMarkerCalls).toBe(0);
    expect(legacyDetailCalls).toBe(0);
  });


  it('retains earlier verified detail progress when a later batch fails', async () => {
    const specs = [
      { id: 1, km: 100 },
      { id: 2, km: 150 },
      { id: 3, km: 200 },
    ];
    const statiq = {
      markers: async () => { throw new Error('legacy markers'); },
      detailsWithMeta: async () => { throw new Error('legacy details'); },
      attachRunBudget: () => {},
      markersBulk: async (points: readonly { lat: number; lon: number }[]) =>
        points.map((p) => {
          const near = specs.find((s) => Math.abs(p.lat * KM_PER_DEG - s.km) <= 13);
          if (!near) {
            return { outcome: 'confirmed-empty' as const, reason: null,
              upstream: { attempts: 1, statuses: [200], fetchedAt: LATER.toISOString() },
              response: { ok: true, live: true, retained: false, source: 'raw-confirmed-empty',
                count: 0, stations: [] } };
          }
          return { outcome: 'ok' as const, reason: null,
            upstream: { attempts: 1, statuses: [200], fetchedAt: LATER.toISOString() },
            response: { ok: true, live: true, retained: false, source: 'bulk', count: 1,
              stations: [{ stationId: near.id, name: `Bulk ${near.id}`,
                lat: near.km / KM_PER_DEG, lon: 0, address: null, accessType: 1,
                isCommunityListed: false, stationUrl: '' }] } };
        }),
      detailsBulk: async (
        _ids: readonly number[],
        _signal: AbortSignal | undefined,
        _context: import('../src/provider-failure.js').ProviderCallContext | undefined,
        onItem?: (result: BulkItemResult<StationDetailsWithMeta>, index: number) => void,
      ): Promise<BulkItemResult<StationDetailsWithMeta>[]> => {
        // First two detail lookups succeed and are ingested incrementally;
        // the later batch then fails fatally before the third is returned.
        for (let i = 0; i < 2; i++) {
          onItem?.({
            outcome: 'ok', reason: null,
            upstream: { attempts: 1, statuses: [200], fetchedAt: LATER.toISOString() },
            response: { response: { ok: true, live: true, retained: false,
              source: 'bulk', station: detail(specs[i]!.id, specs[i]!.km) }, fetchedAt: LATER },
          }, i);
        }
        throw new StatiqRunFatalError('auth', 403, '/stations/details-bulk', 'late batch failure');
      },
    } as unknown as StatiqClient;
    const router = endpointRouter();
    const error = await planTrip({ router, statiq },
      { label: 'Origin', lat: 0, lon: 0 }, { label: 'Destination', lat: 200 / KM_PER_DEG, lon: 0 },
      { startSocPct: 50 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : String(error);
    // Earlier detail work survives the late fatal stop; the never-completed
    // candidate is NOT counted as processed/detailed.
    expect(message).toContain('candidates processed 2/3');
    expect(message).toContain('2 detailed, 1 remaining');
  });


  it('does not double-count when a bulk marker double both calls back and returns', async () => {
    let summaries = 0;
    const statiq = {
      markers: async () => { throw new Error('legacy markers'); },
      detailsWithMeta: async () => { throw new Error('legacy details'); },
      attachRunBudget: () => {},
      markersBulk: async (
        points: readonly { lat: number; lon: number }[],
        _signal?: AbortSignal,
        _context?: import('../src/provider-failure.js').ProviderCallContext,
        onItem?: (result: BulkItemResult<StatiqMarkersResponse>, index: number) => void,
      ): Promise<BulkItemResult<StatiqMarkersResponse>[]> => {
        summaries++;
        return points.map((_p, i) => {
          // One unknown sample in an 18-sample scan => real failedFrac 1/18.
          const item: BulkItemResult<StatiqMarkersResponse> = i === points.length - 1
            ? { outcome: 'unknown', reason: 'upstream_error',
                upstream: { attempts: 1, statuses: [500], fetchedAt: LATER.toISOString() } }
            : { outcome: 'confirmed-empty', reason: null,
                upstream: { attempts: 1, statuses: [200], fetchedAt: LATER.toISOString() },
                response: { ok: true, live: true, retained: false,
                  source: 'raw-confirmed-empty', count: 0, stations: [] } };
          // Both callback AND returned list, like the real StatiqClient.
          onItem?.(item, i);
          return item;
        });
      },
      detailsBulk: async (ids: readonly number[]) => ids.map((id) => ({
        outcome: 'ok' as const, reason: null,
        upstream: { attempts: 1, statuses: [200], fetchedAt: LATER.toISOString() },
        response: { response: { ok: true, live: true, retained: false,
          source: 'bulk', station: detail(id, 150) }, fetchedAt: LATER },
      })),
    } as unknown as StatiqClient;
    const router = endpointRouter();
    const error = await planTrip({ router, statiq },
      { label: 'Origin', lat: 0, lon: 0 }, { label: 'Destination', lat: 200 / KM_PER_DEG, lon: 0 },
      { startSocPct: 50 }).catch((e: unknown) => e);
    expect(summaries).toBe(1);
    const message = error instanceof Error ? error.message : String(error);
    // Exactly ONE failed sample (double ingestion would report two/duplicate
    // progress); the honest scan-coverage message carries that count.
    expect(message).toContain('1 of 18 route samples could not be scanned');
    expect(message).not.toContain('2 of 18');
  });

  it('retains earlier sample progress when a later bulk marker batch fails through the wrapper', async () => {
    let summaryCalls = 0;
    const statiq = {
      markers: async () => { throw new Error('legacy markers'); },
      detailsWithMeta: async () => { throw new Error('legacy details'); },
      attachRunBudget: () => {},
      markersBulk: async (
        points: readonly { lat: number; lon: number }[],
        _signal?: AbortSignal,
        _context?: import('../src/provider-failure.js').ProviderCallContext,
        onItem?: (result: BulkItemResult<StatiqMarkersResponse>, index: number) => void,
      ): Promise<BulkItemResult<StatiqMarkersResponse>[]> => {
        summaryCalls++;
        // First batch items are verified via the forwarded callback; the
        // later batch fails before any return value reaches corridor.
        const firstBatch = Math.min(12, points.length);
        for (let i = 0; i < firstBatch; i++) {
          onItem?.({
            outcome: 'confirmed-empty', reason: null,
            upstream: { attempts: 1, statuses: [200], fetchedAt: LATER.toISOString() },
            response: { ok: true, live: true, retained: false,
              source: 'raw-confirmed-empty', count: 0, stations: [] },
          }, i);
        }
        throw new Error('later marker batch failed');
      },
      detailsBulk: async (ids: readonly number[]) => ids.map((id) => ({
        outcome: 'ok' as const, reason: null,
        upstream: { attempts: 1, statuses: [200], fetchedAt: LATER.toISOString() },
        response: { response: { ok: true, live: true, retained: false,
          source: 'bulk', station: detail(id, 150) }, fetchedAt: LATER },
      })),
    } as unknown as StatiqClient;
    const router = endpointRouter();
    const error = await planTrip({ router, statiq },
      { label: 'Origin', lat: 0, lon: 0 }, { label: 'Destination', lat: 260 / KM_PER_DEG, lon: 0 },
      { startSocPct: 50 }).catch((e: unknown) => e);
    expect(summaryCalls).toBe(1);
    const message = error instanceof Error ? error.message : String(error);
    // 12 early samples survived (23 planned - 11 later holes = 12 covered);
    // the honest scan-coverage message carries the retained count.
    expect(message).toContain('11 of 23 route samples could not be scanned');
    expect(message).not.toContain('23 of 23');
  });
});
