import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CheckedIdHistoryStore, CountersStore, StatiqProvenanceError, TripsStore, resolveVehicle,
} from '@indeev/core';
import { createApp, type AppDeps } from '../src/app.js';
import { buildCheckedIdScopeKey } from '../src/checked-id-scope.js';
import { runSelective } from '../src/selective-run.js';
import { endpointRouter } from '../../../packages/core/test/support/road-fixture.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const headers = { 'Content-Type': 'application/json' };
const origin = { label: 'A', lat: 28.6139, lon: 77.209 };
const destination = { label: 'B', lat: 26.9239, lon: 75.8267 };
const body = JSON.stringify({ origin, destination, startSocPct: 100 });
const station = {
  stationId: 42, name: 'SYNTHETIC ineligible', lat: 27.7, lon: 76.4,
  address: null, area: null, city: null, landmark: null, hours: '00:00 To 23:59',
  openText: 'Open Now', rating: 4, reviewCount: 10, accessType: 'public',
  navUrl: '', stationUrl: '', imageUrl: null, amenities: [], stepsToReach: null,
  chargers: [{ chargerId: 420, name: 'SYNTHETIC 200 kW DC', type: 'DC', kw: 200,
    pricePerKwh: 20, currency: 'INR', lastUsedOn: null, connectors: [{
      displayId: 1, connectorId: 421, type: 'CCS-2', status: 'available', available: true, note: null,
    }] }],
};
const markers = async () => ({ ok: true, live: true, retained: false, source: 'synthetic-test',
  count: 1, stations: [{ stationId: 42, name: station.name, lat: 27.7, lon: 76.4,
    address: null, accessType: 1, isCommunityListed: false, stationUrl: '' }] });
function statiqFor(response: unknown) {
  return { markers, detailsWithMeta: async () => ({ response,
    fetchedAt: new Date('2026-11-22T12:00:00Z') }) } as never;
}
const freshResponse = { ok: true, live: true, retained: false, source: 'synthetic-test', station };
const toolFirst = (turn: number, id = 42) => turn === 1
  ? { content: null, toolCalls: [{ id: 'c1', type: 'function',
    function: { name: 'get_station_details', arguments: JSON.stringify({ ids: [id] }) } }] }
  : { content: JSON.stringify({ chosenStationIds: [], status: 'not_determined' }), toolCalls: [] };

describe('fresh-successful checked-ID eligibility', () => {
  it.each([
    [{ ...freshResponse }, true],
    [{ ...freshResponse, retained: 'false' }, false],
    [{ ok: true, live: true, station }, false],
    [{ ...freshResponse, station: null }, false],
    [{ ...freshResponse, station: { ...station, stationId: 43 } }, false],
    [{ ...freshResponse, ok: false }, false],
    [{ ...freshResponse, live: false }, false],
  ])('records only explicit fresh retained=false identity matches', async (response, expected) => {
    const onFresh = vi.fn();
    let turn = 0;
    await runSelective({ ai: { baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm' },
      aiToolCall: async () => toolFirst(++turn), router: endpointRouter() as never,
      statiq: statiqFor(response), origin, destination, via: [], resolved: resolveVehicle(),
      planOptions: { startSocPct: 100, maxChargerKw: 60 },
      budget: { deadlineMs: 600_000, maxUpstreamCalls: 100 },
      onFreshDetailSuccess: onFresh }).catch(() => {});
    expect(onFresh.mock.calls.length === 1).toBe(expected);
  });

  it('does not record provenance failure', async () => {
    const onFresh = vi.fn();
    const failed = { markers, detailsWithMeta: async () => {
      throw new StatiqProvenanceError('/stations/details');
    } } as never;
    await runSelective({ ai: { baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm' },
      aiToolCall: async () => toolFirst(1), router: endpointRouter() as never,
      statiq: failed, origin, destination, via: [], resolved: resolveVehicle(),
      planOptions: { startSocPct: 100 }, budget: { deadlineMs: 600_000, maxUpstreamCalls: 100 },
      onFreshDetailSuccess: onFresh }).catch(() => {});
    expect(onFresh).not.toHaveBeenCalled();
  });
});

describe('sync/job parity persistence', () => {
  async function deps(): Promise<{ appDeps: AppDeps; historyPath: string; scopeKey: string }> {
    dirs.push(await mkdtemp(join(tmpdir(), 'indev-history-integration-')));
    const dir = dirs[dirs.length - 1]!;
    const historyPath = join(dir, 'checked.json');
    let turn = 0;
    const scopeKey = buildCheckedIdScopeKey({ origin, destination, via: [], resolved: resolveVehicle(),
      planOptions: { startSocPct: 100 }, coverageProfile: 'standard20' });
    const appDeps: AppDeps = {
      mock: false, createStatiq: () => statiqFor(freshResponse),
      router: endpointRouter() as unknown as AppDeps['router'], geocoder: {} as never,
      trips: new TripsStore({ filePath: join(dir, 'trips.json') }),
      counters: new CountersStore({ filePath: join(dir, 'counters.json') }),
      checkedIdHistory: new CheckedIdHistoryStore({ filePath: historyPath }),
      ai: { baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm' },
      aiToolCall: async () => {
        turn += 1;
        return turn === 1
          ? { content: null, toolCalls: [{ id: `c${turn}`, type: 'function',
            function: { name: 'get_station_details', arguments: '{"ids":[42]}' } }] }
          : { content: 'SYNTHETIC_INVALID_FINAL', toolCalls: [] };
      },
    };
    return { appDeps, historyPath, scopeKey };
  }

  it('persists successful IDs after sync failure without changing scope', async () => {
    const { appDeps, historyPath, scopeKey } = await deps();
    await createApp(appDeps).request('/api/ai/plan', { method: 'POST', headers, body });
    const raw = JSON.parse(await readFile(historyPath, 'utf8')) as {
      scopeKey: string; checkedIds: number[];
    };
    expect(raw).toEqual({ version: 1, scopeKey, checkedIds: [42] });
  });

  it('persists successful IDs after long-job failure without changing scope', async () => {
    const { appDeps, historyPath, scopeKey } = await deps();
    const app = createApp(appDeps);
    const started = await app.request('/api/jobs/plan', { method: 'POST', headers, body });
    const job = await started.json() as { jobId: string; capability: string };
    let state = 'running';
    for (let i = 0; i < 200 && state === 'running'; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const polled = await app.request(`/api/jobs/plan/${job.jobId}`,
        { headers: { 'x-job-capability': job.capability } });
      const status = await polled.json() as { state: string };
      state = status.state;
    }
    expect(state).toBe('failed');
    const raw = JSON.parse(await readFile(historyPath, 'utf8')) as {
      scopeKey: string; checkedIds: number[];
    };
    expect(raw).toEqual({ version: 1, scopeKey, checkedIds: [42] });
  });
});
