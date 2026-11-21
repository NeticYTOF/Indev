/**
 * Functional adoption: planTrip uses ordered bulk marker + detail batches
 * when the client supports them; legacy per-call methods are not used.
 * Offline only - no provider calls.
 */
import { describe, expect, it } from 'vitest';
import { planTrip } from '../src/planner.js';
import type { OsrmRouter, RouteResult } from '../src/router.js';
import type { StatiqClient } from '../src/statiq.js';
import type { StatiqStationDetail } from '../src/types.js';

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
    const router = { route: async (): Promise<RouteResult> => {
      const geometry = Array.from({ length: 21 }, (_, i) => ({
        lat: (200 / KM_PER_DEG) * (i / 20), lon: 0,
      }));
      return { distanceKm: 200, durationMin: 200, geometry };
    } } as unknown as OsrmRouter;
    const plan = await planTrip({ router, statiq },
      { label: 'Origin', lat: 0, lon: 0 }, { label: 'Destination', lat: 200 / KM_PER_DEG, lon: 0 });
    expect(plan.stops).toHaveLength(1);
    expect(bulkMarkerCalls).toBeGreaterThan(0);
    expect(bulkDetailCalls).toBe(1);
    expect(legacyMarkerCalls).toBe(0);
    expect(legacyDetailCalls).toBe(0);
  });
});
