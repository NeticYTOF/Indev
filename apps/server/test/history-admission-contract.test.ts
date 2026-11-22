import { describe, expect, it, vi } from 'vitest';
import { resolveVehicle } from '@indeev/core';
import { createApp } from '../src/app.js';
import { runSelective, type SelectiveRunDeps } from '../src/selective-run.js';
import { endpointRouter } from '../../../packages/core/test/support/road-fixture.js';

type AiToolCall = NonNullable<SelectiveRunDeps['aiToolCall']>;
type Message = Parameters<AiToolCall>[0][number];
type Reply = Awaited<ReturnType<AiToolCall>>;
type ToolPayload = {
  planningProgress?: { nextAction?: string; certifiedStationIds?: number[];
    unexaminedCandidateCount?: number };
  admissionOutcome?: {
    kind?: string; requestedCount?: number; admittedCount?: number;
    deferredCount?: number; memoizedCount?: number; freshAttemptedCount?: number;
    freshCertifiedCount?: number; freshNonCertifiedCount?: number;
    remainingUniqueChecks?: number; remainingToolRounds?: number; remainingToolCalls?: number;
    remainingCurrentNewCount?: number; legalNextModes?: readonly string[];
  };
  historyDelta?: {
    newlyDeferred?: Array<{ stationId: number; reason: string }>;
    newlyCheckedIds?: number[]; memoizedIds?: number[];
  };
  facts?: Array<{ stationId: number }>;
  guidanceAdmission?: {
    label?: string; uncheckedScope?: string;
    modes?: Record<string, number[]>;
  };
};

const stop = (): never => { throw new Error('stop after contract capture'); };
const toolCall = (id: string, args: unknown): Reply => ({
  content: null,
  toolCalls: [{ id, type: 'function',
    function: { name: 'get_station_details', arguments: JSON.stringify(args) } }],
});
const toolPayload = (messages: readonly Message[]): ToolPayload =>
  JSON.parse(String(messages[messages.length - 1]?.content)) as ToolPayload;
const userPayload = (messages: readonly Message[]): Record<string, unknown> =>
  JSON.parse(String(messages[1]?.content)) as Record<string, unknown>;
const advisoryIds = (payload: Record<string, unknown>): number[] => {
  const reachability = payload.reachability as {
    initialUnchecked?: Array<{ stationId: number }>;
    frontierUnchecked?: Array<{ stationId: number }>;
  };
  return [...(reachability.initialUnchecked ?? []), ...(reachability.frontierUnchecked ?? [])]
    .map((item) => item.stationId);
};
const stationFor = (stationId: number) => ({
  stationId, name: `SYNTHETIC ${stationId}`, lat: 0.2 + (stationId - 42) * 0.6, lon: 0,
  address: null, area: null, city: null, landmark: null, hours: '00:00 To 23:59',
  openText: 'Open Now', rating: 4, reviewCount: 10, accessType: 'public',
  navUrl: '', stationUrl: '', imageUrl: null, amenities: [], stepsToReach: null,
  chargers: [], summary: { anyDc: false, ccs2Dc: false, maxDcCcs2Kw: null,
    availableNow: false, statusCounts: null },
});
function fixture(ids: number[], detail: ReturnType<typeof vi.fn>) {
  return {
    ai: { baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm' },
    router: endpointRouter() as never,
    statiq: {
      markers: async () => ({ ok: true, live: true, retained: false, source: 'synthetic-test',
        count: ids.length,
        stations: ids.map((id) => ({ stationId: id, name: `SYNTHETIC ${id}`,
          lat: 0.2 + (id - 42) * 0.6, lon: 0, address: null,
          accessType: 1, isCommunityListed: false, stationUrl: '' })) }),
      detailsWithMeta: detail,
    } as never,
    origin: { label: 'A', lat: 0, lon: 0 },
    destination: { label: 'B', lat: 2.56, lon: 0 },
    via: [], resolved: resolveVehicle(), planOptions: { startSocPct: 100 },
    budget: { deadlineMs: 600_000, maxUpstreamCalls: 100 },
  };
}
const failingDetail = () => vi.fn(async (id: number) => ({
  response: { ok: true, live: true, retained: false, source: 'synthetic-test',
    station: stationFor(id) },
  fetchedAt: new Date('2026-11-22T12:00:00Z'),
}));
const certifyingDetail = () => vi.fn(async (id: number) => ({
  response: { ok: true, live: true, retained: false, source: 'synthetic-test',
    station: { ...stationFor(id), chargers: [{
      chargerId: id * 10, name: 'SYNTHETIC 60 kW DC', type: 'DC', kw: 60,
      pricePerKwh: 20, currency: 'INR', lastUsedOn: null, connectors: [{
        displayId: 1, connectorId: id * 10 + 1, type: 'CCS-2',
        status: 'available', available: true, note: null,
      }],
    }], summary: { anyDc: true, ccs2Dc: true, maxDcCcs2Kw: 60,
      availableNow: true, statusCounts: null } } },
  fetchedAt: new Date('2026-11-22T12:00:00Z'),
}));

describe('history-admission host contract', () => {
  it('labels advisory GUIDANCE as HISTORY-ADMISSION-only and documents refresh', async () => {
    type ToolShape = Array<{ function: { description: string;
      parameters: { properties: { historicalRefreshReason?: { description?: string } } } } }>;
    let seenMessages: readonly Message[] = [];
    let seenTools: ToolShape = [];
    const aiToolCall = (async (messages, tools) => {
      seenMessages = messages;
      seenTools = tools as unknown as ToolShape;
      stop();
    }) as AiToolCall;
    const detail = failingDetail();
    await expect(runSelective({ ...fixture([42, 43, 44], detail), aiToolCall,
      history: { available: true, priorCheckedIds: [42] } }))
      .rejects.toThrow('stop after contract capture');
    expect(seenTools[0]?.function.parameters.properties.historicalRefreshReason?.description)
      .toMatch(/explicitly refresh selected prior-run IDs/i);
    const user = userPayload(seenMessages);
    const admission = user.guidanceAdmission as {
      label: string; uncheckedScope: string; modes: Record<string, number[]>;
    };
    expect(admission.label).toMatch(/HISTORY-ADMISSION annotations only/i);
    expect(admission.label).toMatch(/not budget permission or certification/i);
    expect(admission.uncheckedScope).toBe('not_checked_this_run; may_include_prior_run_ids');
    const advisory = advisoryIds(user);
    expect(advisory.length).toBeGreaterThan(0);
    const annotated = Object.values(admission.modes).flat();
    for (const id of advisory) expect(annotated).toContain(id);
    expect(new Set(annotated).size).toBe(annotated.length);
    if (advisory.includes(42)) expect(admission.modes.prior_explicit_refresh).toContain(42);
  });

  it('returns a truthful zero-new-detail outcome for wholly deferred requests', async () => {
    let turn = 0;
    let payload: ToolPayload = {};
    const aiToolCall = (async (messages) => {
      turn += 1;
      if (turn === 1) return toolCall('c1', { ids: [42] });
      payload = toolPayload(messages);
      stop();
    }) as AiToolCall;
    const detail = failingDetail();
    await expect(runSelective({ ...fixture([42, 43, 44], detail), aiToolCall,
      history: { available: true, priorCheckedIds: [42] } }))
      .rejects.toThrow('stop after contract capture');
    expect(detail).not.toHaveBeenCalled();
    expect(payload.admissionOutcome).toMatchObject({
      kind: 'no_new_detail_checks', requestedCount: 1, admittedCount: 0,
      deferredCount: 1, memoizedCount: 0, freshAttemptedCount: 0,
      freshCertifiedCount: 0, freshNonCertifiedCount: 0,
      remainingCurrentNewCount: 2,
      legalNextModes: ['request_actual_unattempted_current_new_ids',
        'request_prior_ids_with_historicalRefreshReason_necessary_bridge'],
    });
    expect(payload.admissionOutcome?.remainingUniqueChecks).toBeGreaterThan(0);
    expect(payload.admissionOutcome?.remainingToolRounds).toBeGreaterThan(0);
    expect(payload.admissionOutcome?.remainingToolCalls).toBeGreaterThan(0);
    expect(payload.planningProgress?.nextAction)
      .toBe('choose_unattempted_current_new_or_explicit_necessary_bridge');
    expect(payload.historyDelta?.newlyDeferred)
      .toEqual([{ stationId: 42, reason: 'prior_checked_deferred' }]);
    expect(payload.facts).toEqual([]);
  });

  it('keeps mixed admitted, deferred and memoized calls distinct', async () => {
    let turn = 0;
    let payload: ToolPayload = {};
    const aiToolCall = (async (messages) => {
      turn += 1;
      if (turn === 1) return toolCall('c1', { ids: [44] });
      if (turn === 2) return toolCall('c2', { ids: [42, 44, 43] });
      payload = toolPayload(messages);
      stop();
    }) as AiToolCall;
    const detail = failingDetail();
    await expect(runSelective({ ...fixture([42, 43, 44], detail), aiToolCall,
      history: { available: true, priorCheckedIds: [42] } }))
      .rejects.toThrow('stop after contract capture');
    expect(detail).toHaveBeenCalledTimes(2);
    expect(payload.admissionOutcome).toMatchObject({
      kind: 'new_details_admitted', requestedCount: 3, admittedCount: 2,
      deferredCount: 1, memoizedCount: 1, freshAttemptedCount: 1,
      freshCertifiedCount: 0, freshNonCertifiedCount: 1,
    });
    expect(payload.admissionOutcome?.legalNextModes).toBeUndefined();
    expect(payload.historyDelta).toMatchObject({
      newlyDeferred: [{ stationId: 42, reason: 'prior_checked_deferred' }],
      newlyCheckedIds: [43], memoizedIds: [44],
    });
    expect(payload.facts?.map((fact) => fact.stationId)).toEqual([44, 43]);
  });

  it('admits an explicit prior refresh without changing admission rules', async () => {
    let turn = 0;
    let payload: ToolPayload = {};
    let error: unknown;
    const aiToolCall = (async (messages) => {
      turn += 1;
      if (turn === 1) return toolCall('c1',
        { ids: [42], historicalRefreshReason: 'necessary_bridge' });
      payload = toolPayload(messages);
      stop();
    }) as AiToolCall;
    const detail = failingDetail();
    await runSelective({ ...fixture([42, 43, 44], detail), aiToolCall,
      history: { available: true, priorCheckedIds: [42] } }).catch((err: unknown) => { error = err; });
    expect(detail).toHaveBeenCalledTimes(1);
    expect(payload.admissionOutcome).toMatchObject({
      kind: 'new_details_admitted', requestedCount: 1, admittedCount: 1,
      deferredCount: 0, memoizedCount: 0, freshAttemptedCount: 1,
    });
    expect(payload.historyDelta?.newlyDeferred).toEqual([]);
    expect((error as { diagnostics: { history: { bridgeIds: number } } }).diagnostics.history.bridgeIds)
      .toBe(1);
  });

  it('advertises ordinary prior bypass after current-new exhaustion', async () => {
    let turn = 0;
    let firstMessages: readonly Message[] = [];
    let payload: ToolPayload = {};
    const aiToolCall = (async (messages) => {
      turn += 1;
      if (turn === 1) {
        firstMessages = messages;
        return toolCall('c1', { ids: [42] });
      }
      payload = toolPayload(messages);
      stop();
    }) as AiToolCall;
    const detail = failingDetail();
    await expect(runSelective({ ...fixture([42], detail), aiToolCall,
      history: { available: true, priorCheckedIds: [42] } }))
      .rejects.toThrow('stop after contract capture');
    expect(detail).toHaveBeenCalledTimes(1);
    const initialAdmission = (userPayload(firstMessages).guidanceAdmission as {
      modes: Record<string, number[]>;
    }).modes;
    expect(initialAdmission.prior_ordinary_bypass).toContain(42);
    expect(payload.admissionOutcome).toMatchObject({
      kind: 'new_details_admitted', deferredCount: 0,
      remainingCurrentNewCount: 0,
    });
    expect(payload.historyDelta?.newlyCheckedIds).toEqual([42]);
    const currentAdmission = payload.guidanceAdmission?.modes ?? {};
    expect(Object.values(currentAdmission).flat()).not.toContain(42);
  });

  it('omits history schemas and refresh modes when history is unavailable', async () => {
    let turn = 0;
    let firstMessages: readonly Message[] = [];
    let payload: ToolPayload = {};
    const aiToolCall = (async (messages) => {
      turn += 1;
      if (turn === 1) {
        firstMessages = messages;
        return toolCall('c1', { ids: [42] });
      }
      payload = toolPayload(messages);
      stop();
    }) as AiToolCall;
    const detail = failingDetail();
    await expect(runSelective({ ...fixture([42, 43], detail), aiToolCall,
      history: { available: false, priorCheckedIds: [42] } }))
      .rejects.toThrow('stop after contract capture');
    expect(userPayload(firstMessages).history).toBeUndefined();
    expect((userPayload(firstMessages).guidanceAdmission as { modes: Record<string, number[]> })
      .modes.current_new_ordinary).toContain(42);
    expect(detail).toHaveBeenCalledTimes(1);
    expect(payload.admissionOutcome).toMatchObject({
      kind: 'new_details_admitted', deferredCount: 0, admittedCount: 1,
    });
    expect(payload.historyDelta).toBeUndefined();
    expect(payload.guidanceAdmission?.modes?.current_new_ordinary).toContain(43);
    expect(payload.guidanceAdmission?.modes?.current_new_ordinary).not.toContain(42);
    expect(payload.guidanceAdmission?.modes?.prior_explicit_refresh ?? []).not.toContain(42);
  });

  it('gives the reserved final turn honest context and keeps strict JSON parsing', async () => {
    let turn = 0;
    let finalTools: readonly unknown[] = [];
    let context: {
      normalAttemptsRemaining: number; toolsAllowed: boolean;
      remainingUniqueChecks: number; remainingToolCalls: number;
      certifiedCount: number; caveat: string;
    } | undefined;
    let error: unknown;
    const aiToolCall = (async (messages, tools) => {
      turn += 1;
      if (turn <= 4) return toolCall(`c${turn}`, { ids: [41 + turn] });
      finalTools = tools;
      const finalMessage = String(messages[messages.length - 1]?.content);
      context = (JSON.parse(finalMessage) as { finalTurnContext: typeof context })
        .finalTurnContext;
      return { content: '{not json', toolCalls: [] };
    }) as AiToolCall;
    const detail = failingDetail();
    await runSelective({ ...fixture([42, 43, 44, 45], detail), aiToolCall })
      .catch((err: unknown) => { error = err; });
    expect(turn).toBe(5);
    expect(finalTools).toEqual([]);
    expect(context).toMatchObject({ normalAttemptsRemaining: 0, toolsAllowed: false,
      certifiedCount: 0 });
    expect(context?.remainingUniqueChecks).toBeGreaterThan(0);
    expect(context?.remainingToolCalls).toBeGreaterThan(0);
    expect(context?.caveat).toMatch(/No claim that every candidate or unique check was exhausted/);
    expect(detail).toHaveBeenCalledTimes(4);
    const diagnostics = (error as { diagnostics: {
      noFitDeclared: boolean; finalAnswerEvents: Array<{ reason: string }>;
    } }).diagnostics;
    expect(diagnostics.noFitDeclared).toBe(false);
    expect(diagnostics.finalAnswerEvents.map((event) => event.reason)).toContain('invalid_final_json');
  });

  it('keeps current-new and refresh requests available after one certified station', async () => {
    let turn = 0;
    let payload: ToolPayload = {};
    const aiToolCall = (async (messages) => {
      turn += 1;
      if (turn === 1) return toolCall('c1', { ids: [43] });
      if (turn === 2) return toolCall('c2', { ids: [43] });
      payload = toolPayload(messages);
      stop();
    }) as AiToolCall;
    const detail = certifyingDetail();
    await expect(runSelective({ ...fixture([42, 43, 44], detail), aiToolCall,
      history: { available: true, priorCheckedIds: [42] } }))
      .rejects.toThrow('stop after contract capture');
    expect(detail).toHaveBeenCalledTimes(1);
    expect(payload.planningProgress?.certifiedStationIds).toEqual([43]);
    expect(payload.admissionOutcome?.kind).toBe('no_new_detail_checks');
    expect(payload.admissionOutcome?.memoizedCount).toBe(1);
    expect(payload.planningProgress?.nextAction)
      .toBe('choose_unattempted_current_new_or_explicit_necessary_bridge');
    expect(payload.admissionOutcome?.legalNextModes).toEqual([
      'choose_from_already_freshly_certified_ids',
      'request_actual_unattempted_current_new_ids',
      'request_prior_ids_with_historicalRefreshReason_necessary_bridge',
    ]);
  });

  it('keeps ordinary prior bypass available after two certified stations', async () => {
    let turn = 0;
    let payload: ToolPayload = {};
    const aiToolCall = (async (messages) => {
      turn += 1;
      if (turn === 1) return toolCall('c1', { ids: [43, 44] });
      if (turn === 2) return toolCall('c2', { ids: [43] });
      payload = toolPayload(messages);
      stop();
    }) as AiToolCall;
    const detail = certifyingDetail();
    await expect(runSelective({ ...fixture([42, 43, 44], detail), aiToolCall,
      history: { available: true, priorCheckedIds: [42] } }))
      .rejects.toThrow('stop after contract capture');
    expect(detail).toHaveBeenCalledTimes(2);
    expect(payload.planningProgress?.certifiedStationIds).toEqual([43, 44]);
    expect(payload.admissionOutcome?.remainingCurrentNewCount).toBe(0);
    expect(payload.planningProgress?.nextAction)
      .toBe('request_prior_ids_by_ordinary_exhaustion_bypass');
    expect(payload.admissionOutcome?.legalNextModes).toEqual([
      'choose_from_already_freshly_certified_ids',
      'request_prior_ids_by_ordinary_exhaustion_bypass',
    ]);
  });

  it('keeps ordinary memo follow-up available without a history schema', async () => {
    let turn = 0;
    let payload: ToolPayload = {};
    const aiToolCall = (async (messages) => {
      turn += 1;
      if (turn === 1) return toolCall('c1', { ids: [42] });
      if (turn === 2) return toolCall('c2', { ids: [42] });
      payload = toolPayload(messages);
      stop();
    }) as AiToolCall;
    const detail = certifyingDetail();
    await expect(runSelective({ ...fixture([42, 43], detail), aiToolCall }))
      .rejects.toThrow('stop after contract capture');
    expect(detail).toHaveBeenCalledTimes(1);
    expect(payload.planningProgress?.certifiedStationIds).toEqual([42]);
    expect(payload.historyDelta).toBeUndefined();
    expect(payload.planningProgress?.nextAction)
      .toBe('inspect_unexamined_candidates_ordinarily');
    expect(payload.admissionOutcome?.legalNextModes).toEqual([
      'choose_from_already_freshly_certified_ids',
      'request_unexamined_candidates_ordinarily',
    ]);
  });

  it('does not advertise another request when no unexamined ID remains', async () => {
    let turn = 0;
    let payload: ToolPayload = {};
    const aiToolCall = (async (messages) => {
      turn += 1;
      if (turn === 1) return toolCall('c1', { ids: [42] });
      if (turn === 2) return toolCall('c2', { ids: [42] });
      payload = toolPayload(messages);
      stop();
    }) as AiToolCall;
    const detail = certifyingDetail();
    await expect(runSelective({ ...fixture([42], detail), aiToolCall }))
      .rejects.toThrow('stop after contract capture');
    expect(payload.planningProgress?.unexaminedCandidateCount).toBe(0);
    expect(payload.planningProgress?.nextAction)
      .toBe('choose_from_certified_or_report_not_determined');
    expect(payload.admissionOutcome?.legalNextModes)
      .toEqual(['choose_from_already_freshly_certified_ids']);
  });

  it('keeps private run admission separate from store-save history diagnostics', async () => {
    type RunEvent = {
      history?: { load: string; save: string; added: number;
        priorCheckedCount: number; recordedCount: number };
      runHistory?: { available: boolean; priorCheckedCount: number; requests: number;
        deferredIds: number; bridgeIds: number; memoizedBypasses: number;
        freshDetailsRecorded: number };
    };
    const events: RunEvent[] = [];
    const detail = failingDetail();
    const base = fixture([42, 43], detail);
    const historyStore = {
      load: async () => ({ status: 'active', checkedIds: [42] }),
      record: async () => ({ ok: true, status: 'saved', added: 0 }),
    } as never;
    let turn = 0;
    const aiToolCall = (async () => {
      turn += 1;
      if (turn === 1) return toolCall('c1', { ids: [42] });
      return { content: '{not json', toolCalls: [] };
    }) as AiToolCall;
    const app = createApp({
      mock: false, createStatiq: () => base.statiq,
      router: endpointRouter() as never, geocoder: {} as never,
      trips: {} as never, counters: {} as never,
      ai: { baseUrl: 'https://ai.test/v1', apiKey: 'k', model: 'm' },
      aiToolCall, checkedIdHistory: historyStore,
      onPlanRunEvent: (event) => { events.push(event as RunEvent); },
    } as never);
    await app.request('/api/ai/plan', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: { label: 'A', lat: 0, lon: 0 },
        destination: { label: 'B', lat: 2.56, lon: 0 }, startSocPct: 100 }),
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.history).toMatchObject({ load: 'active', save: 'not_attempted',
      added: 0, priorCheckedCount: 1, recordedCount: 0 });
    expect(events[0]?.runHistory).toMatchObject({ available: true,
      priorCheckedCount: 1, requests: 1, deferredIds: 1, bridgeIds: 0,
      memoizedBypasses: 0, freshDetailsRecorded: 0 });
  });
});
