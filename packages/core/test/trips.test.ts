import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CountersStore } from '../src/counters.js';
import { TripsStore, toSavedTrip } from '../src/trips.js';
import type { TripPlan } from '../src/plan-types.js';

// Every test gets its own throwaway data dir: the real store is never touched.
const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'indeev-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function fakePlan(overrides: Partial<TripPlan> = {}): TripPlan {
  return {
    id: 'plan-1',
    createdAt: '2026-11-19T10:00:00.000Z',
    origin: { label: 'Delhi', lat: 28.6, lon: 77.2 },
    destination: { label: 'Jaipur', lat: 26.9, lon: 75.8 },
    status: 'ok',
    source: 'live',
    vehicle: {
      label: 'Tata Harrier EV (75 kWh)',
      catalogId: 'tata-harrier-ev-75',
      batteryKwh: 75,
      claimedRangeKm: 627,
      realWorldRangeKm: null,
    },
    routeDistanceKm: 284.9,
    routeDurationMin: 240,
    geometry: [
      { lat: 28.6, lon: 77.2 },
      { lat: 26.9, lon: 75.8 },
    ],
    stops: [
      {
        station: {
          stationId: 1790,
          name: 'Statiq Hotel The Suryaa Station',
          brand: 'statiq',
          lat: 28.56,
          lon: 77.26,
          address: 'Hotel The Suryaa',
          city: 'New Delhi',
          hours: '00:00 To 23:59',
          openText: 'Open Now',
          rating: 4.72,
          reviewCount: 4774,
          reliability: null,
          fetchedAt: '2026-11-19T10:00:00.000Z',
          amenities: ['Cafe'],
          stationUrl: 'https://statiq.in/x',
          navUrl: 'https://maps.google.com/x',
          chargers: [],
        },
        chainageKm: 120,
        legKm: 120.5,
        detourKm: 0.5,
        arriveSocPct: 26,
        leaveSocPct: 80,
        chargeKwh: 38.5,
        pricePerKwh: 22.75,
        estPriceInr: 876,
        chargeTimeMin: 42,
        arrivalEtaMin: 128,
        departureEtaMin: 170,
      },
    ],
    totals: {
      distanceKm: 284.9,
      driveTimeMin: 240,
      chargeTimeMin: 42,
      totalTimeMin: 282,
      chargeKwh: 38.5,
      estPriceInr: 876,
      finalSocPct: 22,
    },
    stationsSeen: 12,
    warnings: [],
    ...overrides,
  };
}

describe('toSavedTrip', () => {
  it('keeps only minimal station references and geometry', () => {
    const saved = toSavedTrip(fakePlan(), 'My trip');
    expect(saved.name).toBe('My trip');
    expect(saved.stations).toHaveLength(1);
    const st = saved.stations[0] as unknown as Record<string, unknown>;
    // station reference is minimal: exactly the reference fields, never
    // rating/reviews/plugs/chargers/station detail
    expect(Object.keys(st).sort()).toEqual([
      'arriveSocPct',
      'chainageKm',
      'chargeKwh',
      'chargeTimeMin',
      'detourKm',
      'estPriceInr',
      'lat',
      'leaveSocPct',
      'legKm',
      'lon',
      'name',
      'pricePerKwh',
      'stationId',
    ]);
    expect(saved.geometry).toEqual([
      [28.6, 77.2],
      [26.9, 75.8],
    ]);
  });
});

describe('TripsStore', () => {
  it('saves, lists, gets and removes trips in an isolated store', async () => {
    const dir = await tempDir();
    const store = new TripsStore({ filePath: join(dir, 'trips.json') });

    expect(await store.list()).toEqual([]);
    const saved = await store.save(fakePlan());
    expect(await store.list()).toHaveLength(1);
    expect((await store.get(saved.id))?.name).toContain('Delhi');

    // remove twice: second time reports false
    expect(await store.remove(saved.id)).toBe(true);
    expect(await store.remove(saved.id)).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it('updates an existing trip by id instead of duplicating', async () => {
    const dir = await tempDir();
    const store = new TripsStore({ filePath: join(dir, 'trips.json') });
    await store.save(fakePlan(), 'Old name');
    const updated = await store.save(fakePlan({ id: 'plan-1' }), 'New name');
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(updated.name).toBe('New name');
    expect((list[0] as { name: string }).name).toBe('New name');
  });

  it('upserts by plan id and keeps newest first', async () => {
    const dir = await tempDir();
    const store = new TripsStore({ filePath: join(dir, 'trips.json') });
    await store.save(fakePlan({ id: 'a', createdAt: '2026-11-18T10:00:00.000Z' }));
    await store.save(fakePlan({ id: 'b', destination: { label: 'Agra', lat: 27.17, lon: 78.01 } }));
    const list = await store.list();
    expect(list).toHaveLength(2);
    expect((list[0] as { id: string }).id).toBe('b');
  });

  it('survives concurrent saves without corrupting the file', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'trips.json');
    const store = new TripsStore({ filePath });
    const plans = Array.from({ length: 10 }, (_, i) => fakePlan({ id: `p${i}` }));
    await Promise.all(plans.map((p) => store.save(p)));
    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    expect(raw).toHaveLength(10);
  });
});

describe('CountersStore', () => {
  it('accumulates the running chargers-seen count across runs', async () => {
    const dir = await tempDir();
    const store = new CountersStore({ filePath: join(dir, 'counters.json') });
    expect((await store.load()).chargersSeen).toBe(0);
    await store.addChargersSeen(12);
    await store.addChargersSeen(30);
    expect((await store.load()).chargersSeen).toBe(42);
    await store.addChargersSeen(-5); // defensive clamp
    expect((await store.load()).chargersSeen).toBe(42);
  });
});
