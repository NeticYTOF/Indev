import { describe, expect, it, vi } from 'vitest';
import { resolveVehicle } from '@indeev/core';
import { runSelective, SelectiveRunError, type SelectiveRunResult } from '../src/selective-run.js';
import { endpointRouter } from '../../../packages/core/test/support/road-fixture.js';

const origin = { label: 'A', lat: 0, lon: 0 };
type DetailFn = (stationId: number) => Promise<{ response: unknown; fetchedAt: Date }>;
const destination = { label: 'B', lat: 2.56, lon: 0 };
const station = (stationId: number, lat: number) => ({
  stationId, name: `SYNTHETIC ${stationId}`, lat, lon: 0,
  address: null, area: null, city: null, landmark: null, hours: '00:00 To 23:59',
  openText: 'Open Now', rating: 4, reviewCount: 10, accessType: 'public',
  navUrl: '', stationUrl: '', imageUrl: null, amenities: [], stepsToReach: null,
  chargers: [{ chargerId: stationId * 10, name: 'SYNTHETIC 200 kW DC', type: 'DC',
    kw: 200, pricePerKwh: 20, currency: 'INR', lastUsedOn: null, connectors: [{
      displayId: 1, connectorId: stationId * 10 + 1, type: 'CCS-2',
      status: 'available', available: true, note: null,
    }] }],
});
function diagnosticsOf(value: unknown): SelectiveRunResult['diagnostics'] {
  if (value instanceof SelectiveRunError) return value.diagnostics;
  throw new Error('expected SelectiveRunError');
}
function deps(aiToolCall: Parameters<typeof runSelective>[0]['aiToolCall'], detail: DetailFn,
  history?: { available: boolean; priorCheckedIds: readonly number[] }) {
  return {
    ai: { baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm' }, aiToolCall,
    router: endpointRouter() as never,
    statiq: {
      markers: async () => ({ ok: true, live: true, retained: false, source: 'synthetic-test',
        count: 3, stations: [
          { stationId: 42, name: 'SYNTHETIC 42', lat: 1, lon: 0, address: null,
            accessType: 1, isCommunityListed: false, stationUrl: '' },
          { stationId: 1000, name: 'SYNTHETIC 1000', lat: 1.5, lon: 0, address: null,
            accessType: 1, isCommunityListed: false, stationUrl: '' },
          { stationId: 2000, name: 'SYNTHETIC 2000', lat: 2, lon: 0, address: null,
            accessType: 1, isCommunityListed: false, stationUrl: '' },
        ] }),
      detailsWithMeta: detail,
    } as never,
    origin, destination, via: [], resolved: resolveVehicle(),
    planOptions: { startSocPct: 50, maxChargerKw: 60 },
    budget: { deadlineMs: 600_000, maxUpstreamCalls: 100 },
    ...(history ? { history } : {}),
  };
}

describe('absent-history legacy validation parity', () => {
  it('lets authoritative ledger classify invalid_id with original requested counts', async () => {
    const detail = vi.fn(async () => ({ response: { ok: true }, fetchedAt: new Date() }));
    const err = await runSelective(deps(async () => ({ content: null, toolCalls: [{
      id: 'bad', type: 'function', function: { name: 'get_station_details', arguments: '{"ids":[0]}' },
    }] }), detail)).catch((e: unknown) => e);
    const d = diagnosticsOf(err);
    expect(d.toolAdmission).toMatchObject({ requestedIds: 4, admittedCalls: 0,
      rejectedByReason: { invalid_id: 4, invalid_shape: 0 } });
    expect(d.detailChecksStarted).toBe(0);
    expect(detail).not.toHaveBeenCalled();
  });

  it('rejects refresh field with zero fetches when history is absent', async () => {
    const detail = vi.fn(async () => ({ response: { ok: true }, fetchedAt: new Date() }));
    const err = await runSelective(deps(async () => ({ content: null, toolCalls: [{
      id: 'ext', type: 'function', function: { name: 'get_station_details',
        arguments: '{"ids":[42],"historicalRefreshReason":"necessary_bridge"}' },
    }] }), detail)).catch((e: unknown) => e);
    const d = diagnosticsOf(err);
    expect(d.toolAdmission.rejectedByReason.invalid_shape).toBeGreaterThan(0);
    expect(d.detailChecksStarted).toBe(0);
    expect(detail).not.toHaveBeenCalled();
  });
});

describe('active-history refresh parity', () => {
  it('allows explicit refresh of a requested prior ID with one real detail check', async () => {
    let turn = 0;
    const detail = vi.fn(async (id: number) => ({ response: { ok: true, live: true,
      retained: false, source: 'synthetic-test', station: station(id, 1) },
      fetchedAt: new Date('2026-11-22T12:00:00Z') }));
    const result = await runSelective(deps(async () => {
      turn += 1;
      return turn === 1 ? { content: null, toolCalls: [{
        id: 'refresh', type: 'function', function: { name: 'get_station_details',
          arguments: '{"ids":[42],"historicalRefreshReason":"necessary_bridge"}' },
      }] } : { content: JSON.stringify({ chosenStationIds: [], status: 'not_determined' }), toolCalls: [] };
    }, detail, { available: true, priorCheckedIds: [42, 1000] })).catch((e: unknown) => e);
    const d = diagnosticsOf(result);
    expect(d.detailChecksStarted).toBe(1);
    expect(d.history.bridgeIds).toBe(1);
    expect(detail).toHaveBeenCalledTimes(1);
    expect(detail.mock.calls[0]?.[0]).toBe(42);
  });
});
