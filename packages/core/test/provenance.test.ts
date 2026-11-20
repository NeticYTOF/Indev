import { expect, it } from 'vitest';
import { hasFreshProvenance } from '../src/provenance.js';
import { StatiqApiError, StatiqClient, StatiqRunFatalError, type UpstreamAuditEntry } from '../src/statiq.js';
import { UpstreamBudget } from '../src/upstream-budget.js';
import { scanCorridor } from '../src/corridor.js';

const invalid = [{ live: false }, { retained: true }, ...['false', 0, 1, null, undefined, {}, []].flatMap(value => [{ live: value }, { retained: value }])];
it.each(invalid)('rejects explicit conflicting or malformed evidence %j', evidence => expect(hasFreshProvenance(evidence)).toBe(false));
it.each([{}, { live: true }, { retained: false }, { live: true, retained: false, source: 'unlisted-label' }])('accepts legacy absent or valid evidence %j', evidence => expect(hasFreshProvenance(evidence)).toBe(true));

it.each(['markers', 'cards', 'details'] as const)('client refuses nonfresh %s, audits one dispatch, no retry or memo admission', async endpoint => {
  let requests = 0; const audit: UpstreamAuditEntry[] = [];
  const client = new StatiqClient({ token: 'offline-only', minCallGapMs: 0, maxCallsPerMinute: 1000, retries: 2,
    fetchImpl: (async () => {
      requests++;
      return new Response(JSON.stringify({ ok: true, live: requests > 1, retained: requests === 1, station: { stationId: 1, chargers: [] }, stations: [], cards: [] }));
    }) as typeof fetch, onUpstreamCall: entry => audit.push(entry),
  });
  const call = () => endpoint === 'details' ? client.detailsWithMeta(1) : client[endpoint](0, 0);
  await expect(call()).rejects.toBeInstanceOf(StatiqApiError);
  expect(requests).toBe(1); expect(audit.map(entry => entry.status)).toEqual([200]);
  await expect(call()).resolves.toBeDefined(); expect(requests).toBe(2);
});

it.each([401, 403, 429])('real fatal %i headers precede provenance checks with one audit', async status => {
  const audit: UpstreamAuditEntry[] = []; const budget = new UpstreamBudget(5);
  const client = new StatiqClient({ token: 'offline-only', retries: 2,
    fetchImpl: (async () => new Response(JSON.stringify({ live: false, retained: true }), { status, headers: { 'retry-after': '30' } })) as typeof fetch,
    onUpstreamCall: entry => audit.push(entry),
  });
  client.attachRunBudget(budget);
  await expect(client.markers(0, 0)).rejects.toBeInstanceOf(StatiqRunFatalError);
  expect(budget.stopped).toBe(status === 429 ? 'throttled' : 'auth'); expect(budget.attemptsMade).toBe(1);
  expect(audit.map(entry => entry.status)).toEqual([status]);
});

it('corridor rejects nonfresh envelope once before consuming even valid prefix records', async () => {
  const progress: number[] = [];
  const result = await scanCorridor({ markers: async () => ({ ok: true, live: false, stations: [{ stationId: 1, name: 'Fixture', lat: 0, lon: 0.05 }] }) } as unknown as StatiqClient, [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.1 }], { onProgress: p => progress.push(p.completed) });
  expect(result.samples).toBe(0); expect(result.failedSamples).toHaveLength(result.samplesPlanned);
  expect(result.stationsSeen).toBe(0); expect(result.candidates).toEqual([]);
  expect(Math.max(...progress)).toBe(result.samplesPlanned);
});

it.each([{}, { live: true, retained: false }])('real client keeps legacy/valid flags compatible: %j', evidence => {
  const client = new StatiqClient({ token: 'offline-only', fetchImpl: (async () => new Response(JSON.stringify({ ok: true, ...evidence, station: null }))) as typeof fetch });
  return expect(client.detailsWithMeta(1)).resolves.toMatchObject({ response: { station: null } });
});

it('does not serve explicitly nonfresh detail evidence inserted into the within-run memo', async () => {
  let calls = 0;
  const client = new StatiqClient({ token: 'offline-only', fetchImpl: (async () => {
    calls++; return new Response(JSON.stringify({ ok: true, live: true, retained: false, station: { stationId: 1 } }));
  }) as typeof fetch });
  const first = await client.detailsWithMeta(1);
  first.response.retained = true;
  await expect(client.detailsWithMeta(1)).rejects.toBeInstanceOf(StatiqApiError);
  expect(calls).toBe(1);
});
