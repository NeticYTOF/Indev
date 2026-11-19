import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../src/app.js';
import {
  CountersStore,
  OsrmRouter,
  PhotonGeocoder,
  StatiqClient,
  TripsStore,
  type RouteResult,
  type StatiqDetailsResponse,
  type StatiqMarkersResponse,
  type StatiqStationDetail,
  type StatiqCharger,
} from '@indeev/core';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const KM_PER_DEG = 111.32;
const TOTAL_KM = 700;

interface StationSpec {
  id: number;
  name: string;
  chainageKm: number;
}

const stations: StationSpec[] = Array.from({ length: 14 }, (_, i) => ({
  id: 700 + i,
  name: `Statiq ${i}`,
  chainageKm: 50 * (i + 1),
}));

function stationDetail(spec: StationSpec): StatiqStationDetail {
  const chargers: StatiqCharger[] = [
    {
      chargerId: spec.id * 10 + 1,
      name: `${spec.name} DC`,
      type: 'DC',
      kw: 60,
      pricePerKwh: 20,
      currency: 'INR',
      lastUsedOn: '19/11/2026',
      connectors: [
        { displayId: 1, connectorId: spec.id * 100, type: 'CCS-2', status: 'available', available: true, note: null },
      ],
    },
  ];
  return {
    stationId: spec.id,
    name: spec.name,
    lat: spec.chainageKm / KM_PER_DEG,
    lon: 0,
    address: null,
    area: null,
    city: null,
    landmark: null,
    hours: '00:00 To 23:59',
    openText: 'Open Now',
    rating: 4.0,
    reviewCount: 100,
    accessType: 'public',
    navUrl: '',
    stationUrl: '',
    imageUrl: null,
    amenities: [],
    stepsToReach: null,
    chargers,
    summary: null,
  };
}

function fakeStatiq(specs: StationSpec[]): StatiqClient {
  const details = new Map(specs.map((s) => [s.id, stationDetail(s)]));
  return {
    markers: async (lat: number): Promise<StatiqMarkersResponse> => {
      const centerKm = lat * KM_PER_DEG;
      const found = specs
        .filter((s) => Math.abs(s.chainageKm - centerKm) <= 13)
        .map((s) => ({
          stationId: s.id,
          name: s.name,
          lat: s.chainageKm / KM_PER_DEG,
          lon: 0,
          address: null,
          accessType: 1,
          isCommunityListed: false,
          stationUrl: '',
        }));
      return { ok: true, live: true, retained: false, source: 'test', count: found.length, stations: found };
    },
    detailsWithMeta: async (id: number): Promise<{ response: StatiqDetailsResponse; fetchedAt: Date }> => ({
      response: {
        ok: true,
        live: true,
        retained: false,
        source: 'test',
        station: details.get(id) ?? null,
      },
      fetchedAt: new Date(),
    }),
  } as unknown as StatiqClient;
}

async function makeDeps(overrides: Partial<AppDeps> = {}): Promise<AppDeps> {
  const dir = await mkdtemp(join(tmpdir(), 'indeev-ai-test-'));
  tempDirs.push(dir);
  const geometry = Array.from({ length: 71 }, (_, i) => ({
    lat: (TOTAL_KM / KM_PER_DEG) * (i / 70),
    lon: 0,
  }));
  return {
    createStatiq: () => fakeStatiq(stations),
    router: {
      route: async (): Promise<RouteResult> => ({
        distanceKm: TOTAL_KM,
        durationMin: TOTAL_KM,
        geometry,
      }),
    } as unknown as OsrmRouter,
    geocoder: {
      search: async (q: string) => [{ name: q, label: q, lat: 0, lon: 0, city: null, state: null, country: 'India' }],
    } as unknown as PhotonGeocoder,
    trips: new TripsStore({ filePath: join(dir, 'trips.json') }),
    counters: new CountersStore({ filePath: join(dir, 'counters.json') }),
    mock: false,
    ...overrides,
  };
}

const ORIGIN = { label: 'Origin', lat: 0, lon: 0 };
const DEST = { label: 'Destination', lat: TOTAL_KM / KM_PER_DEG, lon: 0 };

const AI_CFG = { baseUrl: 'https://ai.test/v1', apiKey: 'sk-test', model: 'test-model' };

describe('POST /api/ai/plan', () => {
  it('is off by default: 503 ai_disabled', async () => {
    const app = createApp(await makeDeps()); // no ai config
    const res = await app.request('/api/ai/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: ORIGIN, destination: DEST }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('ai_disabled');
  });

  it('mock mode serves the synthetic plan even with AI fully configured (never reaches upstream)', async () => {
    const deps = await makeDeps({
      mock: true,
      ai: AI_CFG,
      aiCall: () => {
        throw new Error('AI must never be called in mock mode');
      },
      createStatiq: () => {
        throw new Error('live upstream must never be called in mock mode');
      },
    });
    const app = createApp(deps);
    const res = await app.request('/api/ai/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: ORIGIN, destination: DEST, request: 'prefer cafes' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plan: { source: string; stops: Array<{ station: { stationId: number } }> };
      ai: { applied: boolean; reason: string };
    };
    expect(body.plan.source).toBe('synthetic');
    expect(body.plan.stops.length).toBeGreaterThan(0);
    expect(body.ai.applied).toBe(false);
    expect(body.ai.reason).toContain('mock mode');
  });

  it('applies a valid AI choice and rebuilds the plan coherently', async () => {
    const aiCall = async () =>
      JSON.stringify({ chosenStationIds: [705, 711], notes: 'Evenly spaced stops.' });
    const app = createApp(await makeDeps({ ai: AI_CFG, aiCall }));
    const res = await app.request('/api/ai/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: ORIGIN, destination: DEST, request: 'Prefer well-spaced stops' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plan: { stops: Array<{ station: { stationId: number } }>; warnings: string[] };
      ai: { applied: boolean; notes?: string };
    };
    expect(body.ai.applied).toBe(true);
    expect(body.plan.stops.map((s) => s.station.stationId)).toEqual([705, 711]);
    expect(body.plan.warnings.some((w) => w.includes('AI'))).toBe(true);
  });

  it('falls back to the computed plan when the AI choice is invalid', async () => {
    // id 999 is not a candidate of this run
    const aiCall = async () => JSON.stringify({ chosenStationIds: [999] });
    const app = createApp(await makeDeps({ ai: AI_CFG, aiCall }));
    const res = await app.request('/api/ai/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: ORIGIN, destination: DEST }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plan: { stops: Array<{ station: { stationId: number } }> };
      ai: { applied: boolean; reason: string };
    };
    expect(body.ai.applied).toBe(false);
    expect(body.ai.reason).toContain('rejected');
    // base plan is intact and valid
    expect(body.plan.stops).toHaveLength(2);
  });

  it('falls back to the computed plan when the provider errors', async () => {
    const aiCall = async () => {
      throw new Error('boom');
    };
    const app = createApp(await makeDeps({ ai: AI_CFG, aiCall }));
    const res = await app.request('/api/ai/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: ORIGIN, destination: DEST }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: { stops: unknown[] }; ai: { applied: boolean } };
    expect(body.ai.applied).toBe(false);
    expect(body.plan.stops.length).toBeGreaterThan(0);
  });

  it('never sends occupancy or plug-status fields to the model', async () => {
    let seenPrompt = '';
    const aiCall = async (messages: Array<{ content: string }>) => {
      seenPrompt = messages.map((m) => m.content).join('\n');
      return JSON.stringify({ chosenStationIds: [705, 711] });
    };
    const app = createApp(await makeDeps({ ai: AI_CFG, aiCall }));
    await app.request('/api/ai/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: ORIGIN, destination: DEST }),
    });
    // the prompt carries the candidates array: verify by DATA SHAPE, not by
    // forbidding English words like "charging" (the model gets none of the
    // plug status/occupancy vocabulary as data)
    const candidatesMatch = /\"candidates\":\s*\[/.exec(seenPrompt);
    expect(candidatesMatch).not.toBeNull();
    // extract the candidates JSON and assert its shape has no status fields
    const slices = seenPrompt.split('"candidates":').slice(1);
    const candSlice = slices[0] ?? '';
    expect(candSlice).not.toMatch(/\"(available|occupied|status|connectors|plugs|chargers)\"/i);
    // and the AI-safe field set is exactly what we designed (ai-plan.test)n
    expect(seenPrompt).toContain('"chosenStationIds"');
  });
});
