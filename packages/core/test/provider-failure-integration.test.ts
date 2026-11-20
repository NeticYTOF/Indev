import { describe, expect, it } from 'vitest';
import { planTripDetailed } from '../src/planner.js';
import { scanCorridor } from '../src/corridor.js';
import { createProviderFailureCollector } from '../src/provider-failure.js';
import { StatiqClient } from '../src/statiq.js';
import { UpstreamBudget } from '../src/upstream-budget.js';
import { cumulativeKm } from '../src/geo.js';
import type { Coords } from '../src/geo.js';
import type { StatiqDetailsResponse, StatiqMarkersResponse } from '../src/types.js';

const ROUTE: Coords[] = [];
for (let i = 0; i <= 24; i++) ROUTE.push({ lat: 28 + i * (12 / 111.32), lon: 77 });
const KM_PER_SAMPLE = 12;

function emptyMarkers(): StatiqMarkersResponse {
  return { ok: true, live: true, retained: false, source: 'fixture', count: 0, stations: [] };
}

describe('per-run provider evidence integration', () => {
  it('uses scan index for sample ordinal even when completion order is reversed', async () => {
    const observedOrdinals: Array<number | null | undefined> = [];
    let call = 0;
    const statiq = {
      markers: async (
        _lat: number,
        _lon: number,
        _signal?: AbortSignal,
        context?: { sampleOrdinal?: number | null },
      ): Promise<StatiqMarkersResponse> => {
        observedOrdinals.push(context?.sampleOrdinal);
        const current = call++;
        if (current === 0) await new Promise<void>((resolve) => setTimeout(resolve, 10));
        return emptyMarkers();
      },
    };
    await scanCorridor(statiq, ROUTE, { concurrency: 2 });
    const totalKm = cumulativeKm(ROUTE).at(-1) ?? 0;
    const expectedSamples = Math.ceil(totalKm / KM_PER_SAMPLE) + 1;
    expect(observedOrdinals.slice(0, 2)).toEqual([1, 2]);
    expect(observedOrdinals).toHaveLength(expectedSamples);
    expect(observedOrdinals.at(-1)).toBe(expectedSamples);
  });

  it('keeps simultaneous run collectors isolated', async () => {
    const first = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const second = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const clients = [first, second].map((collector) => {
      const client = new StatiqClient({
        token: 'fixture',
        fetchImpl: async () => new Response('bad', { status: 400 }),
        retries: 0,
        maxCallsPerMinute: 1_000_000,
        minCallGapMs: 0,
        sleepImpl: async () => {},
      });
      client.attachRunBudget(new UpstreamBudget(1), collector);
      return client;
    });
    const results = await Promise.allSettled(clients.map((client) => client.markers(0, 0)));
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(first.snapshot().failures).toHaveLength(1);
    expect(second.snapshot().failures).toHaveLength(1);
    expect(first.snapshot().failures[0]?.dispatchSeq).toBe(1);
    expect(second.snapshot().failures[0]?.dispatchSeq).toBe(1);
  });

  it('records invalid marker list and record with sample ordinals', async () => {
    const collector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const route: Coords[] = [{ lat: 28, lon: 77 }, { lat: 28.1, lon: 77 }];
    const badList = {
      markers: async (): Promise<StatiqMarkersResponse> => ({
        ok: true, live: true, retained: false, source: 'fixture', count: 0,
        stations: undefined as never,
      }),
    };
    await scanCorridor(badList, route, { failureCollector: collector });
    expect(collector.snapshot().failures[0]).toMatchObject({
      endpointClass: 'stations/markers', phase: 'scan',
      sampleOrdinal: 1, httpStatus: 200, code: 'invalid_marker_list',
    });

    const second = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const badRecord = {
      markers: async (): Promise<StatiqMarkersResponse> => ({
        ok: true, live: true, retained: false, source: 'fixture', count: 1,
        stations: [{ stationId: -1 } as never],
      }),
    };
    await scanCorridor(badRecord, route, { failureCollector: second });
    expect(second.snapshot().failures[0]).toMatchObject({
      endpointClass: 'stations/markers', phase: 'scan',
      sampleOrdinal: 1, httpStatus: 200, code: 'invalid_marker_record',
    });
  });

  it('distinguishes known scan, detail, and route failure codes', async () => {
    const routeCollector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const badRouter = { route: async () => { throw new Error('router offline'); } };
    await expect(
      planTripDetailed(
        { router: badRouter as never, statiq: {} as never, failureCollector: routeCollector },
        { label: 'A', lat: 28, lon: 77 },
        { label: 'B', lat: 29, lon: 77 },
      ),
    ).rejects.toThrow();
    expect(routeCollector.snapshot().failures[0]).toMatchObject({
      endpointClass: 'none', phase: 'route',
      dispatchSeq: null, httpStatus: null, code: 'route_failed',
    });

    const route = [{ lat: 28, lon: 77 }, { lat: 28.1, lon: 77 }] as Coords[];
    const scalarStation: StatiqDetailsResponse = {
      ok: true, live: true, retained: false, source: 'fixture',
      station: {
        stationId: 1, name: 'Bad scalars', lat: 28.05, lon: 77,
        address: null, area: null, city: null, landmark: null, hours: null,
        openText: null, rating: null, reviewCount: null, accessType: null,
        navUrl: '', stationUrl: '', imageUrl: null, amenities: [], stepsToReach: null,
        chargers: [
          {
            chargerId: 11, name: 'Valid power', type: 'DC', kw: 60, pricePerKwh: -2,
            currency: 'INR', lastUsedOn: null,
            connectors: [{
              displayId: 1, connectorId: 1, type: 'CCS-2',
              status: 'available', available: true, note: null,
            }],
          },
          {
            chargerId: 12, name: 'Invalid power', type: 'DC', kw: -1, pricePerKwh: 20,
            currency: 'INR', lastUsedOn: null,
            connectors: [{
              displayId: 2, connectorId: 2, type: 'CCS-2',
              status: 'available', available: true, note: null,
            }],
          },
        ],
        summary: null,
      } as never,
    };
    const availabilityStation: StatiqDetailsResponse = {
      ok: true, live: true, retained: false, source: 'fixture',
      station: {
        stationId: 2, name: 'Invalid availability', lat: 28.07, lon: 77,
        address: null, area: null, city: null, landmark: null, hours: null,
        openText: null, rating: null, reviewCount: null, accessType: null,
        navUrl: '', stationUrl: '', imageUrl: null, amenities: [], stepsToReach: null,
        chargers: [{
          chargerId: 21, name: 'DC', type: 'DC', kw: 60, pricePerKwh: 20,
          currency: 'INR', lastUsedOn: null,
          connectors: [{
            displayId: 3, connectorId: 3, type: 'CCS-2',
            status: 'available', available: 'false' as never, note: null,
          }],
        }],
        summary: null,
      } as never,
    };
    const detailCollector = createProviderFailureCollector({
      now: () => ({ wallMs: 0, monotonicMs: 0 }),
    });
    const statiq = {
      markers: async (): Promise<StatiqMarkersResponse> => ({
        ok: true, live: true, retained: false, source: 'fixture', count: 2,
        stations: [
          { stationId: 1, name: 'Bad scalars', lat: 28.05, lon: 77,
            address: null, accessType: 1, isCommunityListed: false, stationUrl: '' },
          { stationId: 2, name: 'Invalid availability', lat: 28.07, lon: 77,
            address: null, accessType: 1, isCommunityListed: false, stationUrl: '' },
        ],
      }),
      detailsWithMeta: async (id: number, _signal?: AbortSignal, context?: { onDispatch?: (seq: number) => void }) => {
        context?.onDispatch?.(7);
        return { response: id === 1 ? scalarStation : availabilityStation, fetchedAt: new Date() };
      },
    };
    await planTripDetailed(
      { router: { route: async () => ({ distanceKm: 20, durationMin: 20, geometry: route }) } as never,
        statiq: statiq as never, failureCollector: detailCollector },
      { label: 'A', lat: 28, lon: 77 },
      { label: 'B', lat: 28.1, lon: 77 },
      { runBudget: { deadlineMs: 1000, maxUpstreamCalls: 5 } },
    );
    const failures = detailCollector.snapshot().failures;
    expect(failures.map((record) => record.code)).toEqual(expect.arrayContaining([
      'invalid_connector_availability', 'invalid_charger_power', 'invalid_tariff',
    ]));
    expect(failures.every((record) =>
      record.endpointClass === 'stations/details' && record.phase === 'details' &&
      record.httpStatus === 200 && record.dispatchSeq === 7)).toBe(true);
  });
});
