import { describe, expect, it, vi } from 'vitest';
import { resolveVehicle } from '@indeev/core';
import { buildReachabilityGuidance,
  type GuidanceOptions, type GuidancePoint } from '../src/reachability-guidance.js';
import { buildCurrentNewAdvisory, currentNewAdvisoryChanges,
  type CurrentNewAdvisory } from '../src/current-new-advisory.js';
import { runSelective, type SelectiveRunDeps } from '../src/selective-run.js';
import { endpointRouter } from '../../../packages/core/test/support/road-fixture.js';

const routeKm = 285;
const opts: GuidanceOptions = { startSocPct: 100, minArrivalSocPct: 10,
  absoluteMaxSocPct: 100, maxLegKm: 250 };
const vehicle = resolveVehicle().config;
const geometry = [{ lat: 0, lon: 0 }, { lat: 2.56, lon: 0 }];
const points: GuidancePoint[] = Array.from({ length: 60 }, (_, index) => ({
  stationId: 100 + index, chainageKm: 5 + index * 3, offRouteKm: 0.1,
}));
const original = buildReachabilityGuidance(routeKm, points, [], new Set<number>(),
  opts, vehicle, geometry);
const priorIds = new Set(original.initialUnchecked.map((item) => item.stationId));
const currentView = (excludedIds: ReadonlySet<number>, certified: readonly GuidancePoint[] = []) =>
  buildCurrentNewAdvisory({ routeKm, candidates: points, certified, excludedIds,
    opts, vehicle, geometry });
const reconstructed = (initial: CurrentNewAdvisory, current: CurrentNewAdvisory) => ({
  ...initial, ...currentNewAdvisoryChanges(initial, current),
  scope: initial.scope, semantics: initial.semantics,
});

describe('current-new advisory exposure', () => {
  it('exposes forty novel reachable IDs when the original sample is all prior', () => {
    expect(original.initialUncheckedCount).toBe(60);
    expect(original.initialUnchecked).toHaveLength(20);
    expect(original.initialUnchecked.every((item) => priorIds.has(item.stationId))).toBe(true);
    const view = currentView(priorIds);
    expect(view.scope).toBe('current_new_advisory');
    expect(view.initialUncheckedCount).toBe(40);
    expect(view.initialUnchecked).toHaveLength(20);
    expect(view.initialUnchecked.every((item) => !priorIds.has(item.stationId))).toBe(true);
    expect(view.caveat).toMatch(/not live certification/i);
    expect(view.caveat).toMatch(/not .*budget permission/i);
    expect(view.semantics).toMatch(/zero is not a global absence claim/i);
  });

  it('reports true full-pool counts and bounded novel samples', () => {
    const view = currentView(priorIds);
    expect(view.initialUncheckedCount).toBe(40);
    expect(view.uncheckedCandidateCount).toBe(40);
    expect(view.initialUnchecked).toHaveLength(20);
    expect(view.frontierUnchecked.length).toBeLessThanOrEqual(20);
    expect(view.initialUncheckedCount).toBeGreaterThan(view.initialUnchecked.length);
  });

  it('excludes current-run checked IDs from the supplementary view', () => {
    const initial = currentView(priorIds);
    const checked = new Set(initial.initialUnchecked.slice(0, 3).map((item) => item.stationId));
    const excluded = new Set<number>([...priorIds, ...checked]);
    const view = currentView(excluded);
    expect(view.initialUncheckedCount).toBe(37);
    expect(view.uncheckedCandidateCount).toBe(37);
    for (const id of checked) {
      expect(view.initialUnchecked.some((item) => item.stationId === id)).toBe(false);
      expect(view.frontierUnchecked.some((item) => item.stationId === id)).toBe(false);
    }
  });

  it('advances the frontier from a freshly certified prior station', () => {
    const certifiedId = [...priorIds][0]!;
    const certified = points.filter((point) => point.stationId === certifiedId);
    const view = currentView(priorIds, certified);
    expect(view.chain?.stationIds).toContain(certifiedId);
    const certifiedPoint = certified[0]!;
    for (const item of view.frontierUnchecked) {
      const point = points.find((candidate) => candidate.stationId === item.stationId)!;
      expect(point.chainageKm).toBeGreaterThan(certifiedPoint.chainageKm);
    }
  });

  it('propagates unchanged route geometry and advisory options', () => {
    const view = currentView(priorIds);
    expect(view.routeDistanceKm).toBe(original.routeDistanceKm);
    expect(view.initialReachKm).toBe(original.initialReachKm);
    expect(view.caveat).toContain(original.caveat);
  });

  it('treats a zero current-frontier count as scoped, not global absence', () => {
    const view = currentView(new Set(points.map((point) => point.stationId)));
    expect(view.initialUncheckedCount).toBe(0);
    expect(view.frontierUncheckedCount).toBe(0);
    expect(view.initialUnchecked).toEqual([]);
    expect(view.frontierUnchecked).toEqual([]);
    expect(view.semantics).toMatch(/zero is not a global absence claim/i);
  });

  it('reconstructs the exact supplementary snapshot from bounded deltas', () => {
    const initial = currentView(priorIds);
    const checked = new Set(initial.initialUnchecked.slice(0, 2).map((item) => item.stationId));
    const next = currentView(new Set<number>([...priorIds, ...checked]));
    const delta = currentNewAdvisoryChanges(initial, next);
    expect(reconstructed(initial, next)).toEqual(next);
    expect(delta.initialUncheckedCount).toBe(38);
    expect(delta.uncheckedCandidateCount).toBe(38);
    const empty = currentView(new Set(points.map((point) => point.stationId)));
    const emptyDelta = currentNewAdvisoryChanges(initial, empty);
    expect(reconstructed(initial, empty)).toEqual(empty);
    expect(emptyDelta.initialUnchecked).toEqual([]);
    expect(emptyDelta.frontierUnchecked).toEqual([]);
    expect(emptyDelta.initialUncheckedCount).toBe(0);
    expect(emptyDelta.frontierUncheckedCount).toBe(0);
  });

  it('preserves source invalid-input caveats with scoped supplementary caveats', () => {
    const invalid = buildCurrentNewAdvisory({ routeKm, candidates: points,
      certified: [], excludedIds: priorIds,
      opts: { ...opts, startSocPct: -1 }, vehicle, geometry });
    expect(invalid.caveat).toContain('Invalid inputs; no reachability claim is made.');
    expect(invalid.caveat).toMatch(/estimated initial\/current-best-frontier exploration only/i);
    expect(invalid.initialUnchecked).toEqual([]);
    expect(invalid.semantics).toMatch(/candidate and sample scope is the full current pool/i);
    expect(invalid.semantics).toMatch(/ALL freshly certified IDs, including prior IDs/i);
  });

  type AiToolCall = NonNullable<SelectiveRunDeps['aiToolCall']>;
  type Message = Parameters<AiToolCall>[0][number];
  type Reply = Awaited<ReturnType<AiToolCall>>;
  type UserPayload = {
    candidates: unknown; reachability: unknown;
    guidanceAdmission: { modes: Record<string, number[]> };
    currentNewAdvisory?: CurrentNewAdvisory & Record<string, unknown>;
  };
  type ToolPayload = {
    currentNewAdvisory?: unknown;
    currentNewAdvisoryDelta?: { sinceInitial: boolean; changes: Partial<CurrentNewAdvisory> };
    admissionOutcome?: { admittedCount?: number; deferredCount?: number };
  };
  const stop = (): never => { throw new Error('capture complete'); };
  const toolCall = (id: string, args: unknown): Reply => ({ content: null,
    toolCalls: [{ id, type: 'function',
      function: { name: 'get_station_details', arguments: JSON.stringify(args) } }] });
  const userPayload = (messages: readonly Message[]) =>
    JSON.parse(String(messages[1]?.content)) as UserPayload;
  const toolPayload = (messages: readonly Message[]) =>
    JSON.parse(String(messages[messages.length - 1]?.content)) as ToolPayload;
  const detailFor = () => vi.fn(async (id: number) => ({
    response: { ok: true, live: true, retained: false, source: 'synthetic-test',
      station: { stationId: id, name: `SYNTHETIC ${id}`, lat: id / 111.32, lon: 0,
        address: null, area: null, city: null, landmark: null, hours: '00:00 To 23:59',
        openText: 'Open Now', rating: 4, reviewCount: 10, accessType: 'public',
        navUrl: '', stationUrl: '', imageUrl: null, amenities: [], stepsToReach: null,
        chargers: [], summary: null } },
    fetchedAt: new Date('2026-11-22T12:00:00Z'),
  }));
  const baseDeps = (detail: ReturnType<typeof detailFor>) => ({
    ai: { baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm' },
    router: endpointRouter() as never,
    statiq: {
      markers: async () => ({ ok: true, live: true, retained: false, source: 'synthetic-test',
        count: points.length, stations: points.map((point) => ({
          stationId: point.stationId, name: `SYNTHETIC ${point.stationId}`,
          lat: point.chainageKm / 111.32, lon: 0, address: null,
          accessType: 1, isCommunityListed: false, stationUrl: '',
        })) }),
      detailsWithMeta: detail,
    } as never,
    origin: { label: 'A', lat: 0, lon: 0 },
    destination: { label: 'B', lat: 2.56, lon: 0 },
    via: [], resolved: resolveVehicle(),
    planOptions: { startSocPct: 100, minArrivalSocPct: 10, maxLegKm: 250 },
    budget: { deadlineMs: 600_000, maxUpstreamCalls: 100 },
  });
  const captureInitial = async (history?: { available: boolean; priorCheckedIds: readonly number[] }) => {
    let messages: readonly Message[] = [];
    const aiToolCall = (async (seen: readonly Message[]) => {
      messages = seen;
      stop();
    }) as AiToolCall;
    await expect(runSelective({ ...baseDeps(detailFor()), aiToolCall,
      ...(history ? { history } : {}) })).rejects.toThrow('capture complete');
    return userPayload(messages);
  };

  it('keeps original catalog, guidance and annotations while adding a scoped snapshot', async () => {
    const baseline = await captureInitial();
    const prior = baseline.reachability as { initialUnchecked: Array<{ stationId: number }> };
    const priorCheckedIds = prior.initialUnchecked.map((item) => item.stationId);
    const historic = await captureInitial({ available: true, priorCheckedIds });
    expect(historic.candidates).toEqual(baseline.candidates);
    expect(historic.reachability).toEqual(baseline.reachability);
    expect(Object.keys(historic.guidanceAdmission.modes).sort())
      .toEqual(Object.keys(baseline.guidanceAdmission.modes).sort());
    for (const id of priorCheckedIds) {
      expect(historic.guidanceAdmission.modes.prior_explicit_refresh).toContain(id);
    }
    expect(baseline.currentNewAdvisory).toBeUndefined();
    expect(historic.currentNewAdvisory?.scope).toBe('current_new_advisory');
    expect(historic.currentNewAdvisory?.initialUncheckedCount).toBeGreaterThan(20);
    expect(historic.currentNewAdvisory?.initialUnchecked.some((item) =>
      priorCheckedIds.includes(item.stationId))).toBe(false);
  });

  it('excludes this-run checked IDs and sends only an exact supplementary delta', async () => {
    const baseline = await captureInitial();
    const priorCheckedIds = (baseline.reachability as {
      initialUnchecked: Array<{ stationId: number }>;
    }).initialUnchecked.map((item) => item.stationId);
    const initialMessages: Array<{ id: number; view: CurrentNewAdvisory }> = [];
    let payload: ToolPayload = {};
    let turn = 0;
    const detail = detailFor();
    const aiToolCall = (async (messages) => {
      turn += 1;
      if (turn === 1) {
        const view = userPayload(messages).currentNewAdvisory!;
        const id = view.initialUnchecked[0]!.stationId;
        initialMessages.push({ id, view });
        return toolCall('c1', { ids: [id] });
      }
      payload = toolPayload(messages);
      stop();
    }) as AiToolCall;
    await expect(runSelective({ ...baseDeps(detail), aiToolCall,
      history: { available: true, priorCheckedIds } })).rejects.toThrow('capture complete');
    const { id, view } = initialMessages[0]!;
    expect(detail).toHaveBeenCalledTimes(1);
    expect(payload.currentNewAdvisory).toBeUndefined();
    expect(payload.currentNewAdvisoryDelta?.sinceInitial).toBe(true);
    const delta = payload.currentNewAdvisoryDelta!;
    const updated = { ...view, ...delta.changes,
      scope: view.scope, semantics: view.semantics } as CurrentNewAdvisory;
    expect(updated.initialUncheckedCount).toBeLessThan(view.initialUncheckedCount);
    expect(updated.initialUnchecked.some((item) => item.stationId === id)).toBe(false);
    expect(updated.frontierUnchecked.some((item) => item.stationId === id)).toBe(false);
  });

  it('still admits a useful old bridge with explicit refresh intent', async () => {
    const baseline = await captureInitial();
    const priorCheckedIds = (baseline.reachability as {
      initialUnchecked: Array<{ stationId: number }>;
    }).initialUnchecked.map((item) => item.stationId);
    let turn = 0;
    let payload: ToolPayload = {};
    const detail = detailFor();
    const aiToolCall = (async (messages) => {
      turn += 1;
      if (turn === 1) return toolCall('c1', { ids: [priorCheckedIds[0]!],
        historicalRefreshReason: 'necessary_bridge' });
      payload = toolPayload(messages);
      stop();
    }) as AiToolCall;
    await expect(runSelective({ ...baseDeps(detail), aiToolCall,
      history: { available: true, priorCheckedIds } })).rejects.toThrow('capture complete');
    expect(detail).toHaveBeenCalledTimes(1);
    expect(payload.admissionOutcome).toMatchObject({ admittedCount: 1, deferredCount: 0 });
  });

  it('leaves the unavailable-history payload without supplementary namespaces', async () => {
    const initial = await captureInitial({ available: false, priorCheckedIds: [100] });
    expect(Object.keys(initial)).not.toContain('currentNewAdvisory');
    let turn = 0;
    let payload: ToolPayload = {};
    const aiToolCall = (async (messages) => {
      turn += 1;
      if (turn === 1) return toolCall('c1', { ids: [100] });
      payload = toolPayload(messages);
      stop();
    }) as AiToolCall;
    await expect(runSelective({ ...baseDeps(detailFor()), aiToolCall,
      history: { available: false, priorCheckedIds: [100] } }))
      .rejects.toThrow('capture complete');
    expect(payload.currentNewAdvisory).toBeUndefined();
    expect(payload.currentNewAdvisoryDelta).toBeUndefined();
  });
});
