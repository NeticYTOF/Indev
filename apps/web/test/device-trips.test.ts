/**
 * On-device saved trips (hosted deployment): same minimal form as the
 * server store, same response shapes as the HTTP routes, and unreadable
 * data is never overwritten. Local servers keep using HTTP.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TripPlan } from '@indeev/core';
import { toSavedTrip } from '@indeev/core/trip-shape';

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
}

function plan(id: string): TripPlan {
  return {
    id, createdAt: '2026-11-21T12:00:00Z', source: 'live', status: 'ok',
    origin: { label: 'Delhi', lat: 28.6, lon: 77.2 },
    destination: { label: 'Jaipur', lat: 26.9, lon: 75.8 },
    vehicle: { label: 'Fixture EV', catalogId: null, batteryKwh: 75, claimedRangeKm: null, realWorldRangeKm: 300 },
    routeDistanceKm: 285, routeDurationMin: 270,
    geometry: [{ lat: 28.6, lon: 77.2 }, { lat: 26.9, lon: 75.8 }],
    warnings: [], stationsSeen: 0, stops: [],
    totals: { distanceKm: 285, driveTimeMin: 270, chargeTimeMin: 0, totalTimeMin: 270,
      chargeKwh: 0, estPriceInr: null, finalSocPct: 40 },
  } as unknown as TripPlan;
}

let storage: MemoryStorage;
let healthBody: unknown;
let fetchPaths: string[];

beforeEach(() => {
  vi.resetModules();
  storage = new MemoryStorage();
  healthBody = { ok: true, mock: false, hosted: true };
  fetchPaths = [];
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('fetch', async (path: string) => {
    fetchPaths.push(String(path));
    if (String(path) === '/api/health') return new Response(JSON.stringify(healthBody), { status: 200 });
    return new Response(JSON.stringify({ trips: [{ id: 'from-server' }] }), { status: 200 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('device trips (hosted)', () => {
  it('saves the exact minimal server form and lists newest first', async () => {
    const { api } = await import('../src/api.js');
    const first = await api.saveTrip(plan('a'));
    await api.saveTrip(plan('b'), 'Named');
    expect(first.trip).toEqual(toSavedTrip(plan('a')));
    const { trips } = await api.trips();
    expect(trips.map((t) => t.id)).toEqual(['b', 'a']);
    expect(trips[0]?.name).toBe('Named');
    expect((await api.trip('a')).trip.id).toBe('a');
    // Only the one health probe reached the network.
    expect(fetchPaths).toEqual(['/api/health']);
  });

  it('re-saving the same plan id replaces it instead of duplicating', async () => {
    const { api } = await import('../src/api.js');
    await api.saveTrip(plan('a'));
    await api.saveTrip(plan('a'), 'Renamed');
    const { trips } = await api.trips();
    expect(trips).toHaveLength(1);
    expect(trips[0]?.name).toBe('Renamed');
  });

  it('delete answers like the HTTP route (200 then 404)', async () => {
    const { api } = await import('../src/api.js');
    await api.saveTrip(plan('a'));
    const ok = await api.deleteTrip('a');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    const missing = await api.deleteTrip('a');
    expect(missing.status).toBe(404);
    expect((await missing.json() as { code: string }).code).toBe('not_found');
  });

  it('never overwrites unreadable stored data', async () => {
    storage.setItem('indeev.savedTrips.v1', '{not json');
    const { api } = await import('../src/api.js');
    await expect(api.saveTrip(plan('a'))).rejects.toMatchObject({ code: 'storage_corrupt' });
    expect(storage.getItem('indeev.savedTrips.v1')).toBe('{not json');
  });

  it('rejects a plan missing the fields the server route requires', async () => {
    const { api } = await import('../src/api.js');
    await expect(api.saveTrip({ id: 'x' } as unknown as TripPlan)).rejects.toMatchObject({ code: 'bad_request' });
    expect(storage.getItem('indeev.savedTrips.v1')).toBeNull();
  });

  it('a local (non-hosted) server keeps using the HTTP routes', async () => {
    healthBody = { ok: true, mock: false };
    const { api } = await import('../src/api.js');
    const { trips } = await api.trips();
    expect(trips).toEqual([{ id: 'from-server' }]);
    expect(fetchPaths).toEqual(['/api/health', '/api/trips']);
  });
});
