import { describe, expect, it } from 'vitest';
import type { VehicleConfig } from '@indeev/core';
import { buildReachabilityGuidance, type GuidanceOptions } from '../src/reachability-guidance.js';

const vehicle: VehicleConfig = {
  batteryKwh: 75, usableFraction: 0.95, whPerKm: 175,
  maxDcKw: 70, taperStartSocPct: 80, taperEndPowerKw: 24,
};
const opts: GuidanceOptions = {
  startSocPct: 50, minArrivalSocPct: 10, absoluteMaxSocPct: 95, maxLegKm: 300,
};
const p = (stationId: number, chainageKm: number, offRouteKm = 0) =>
  ({ stationId, chainageKm, offRouteKm });

describe('advisory reachability guidance', () => {
  it('respects low SoC, custom vehicle consumption, and max leg', () => {
    const small: VehicleConfig = { ...vehicle, batteryKwh: 50, whPerKm: 200 };
    const guidance = buildReachabilityGuidance(300,
      [p(1, 10), p(2, 30), p(3, 80)], [], new Set(),
      { ...opts, startSocPct: 20, maxLegKm: 100 }, small);
    expect(guidance.initialReachKm).toBeCloseTo(23.75);
    expect(guidance.initialUnchecked.map((x) => x.stationId)).toEqual([1]);
    expect(guidance.initialUncheckedCount).toBe(1);
    expect(guidance.directDestinationReachable).toBe(false);
  });

  it('includes prior and next estimated detour in leg arithmetic', () => {
    const guidance = buildReachabilityGuidance(300,
      [p(1, 100, 20), p(2, 230, 5)], [p(1, 100, 20)], new Set([1]), opts, vehicle);
    expect(guidance.chain).toMatchObject({
      stationIds: [1], cursorChainageKm: 100, cursorDetourKm: 20,
    });
    expect(guidance.frontierUnchecked).toEqual([{ stationId: 2, legEstKm: 155 }]);
  });

  it('rejects a disconnected far certified stop rather than treating it as a frontier', () => {
    const guidance = buildReachabilityGuidance(500,
      [p(1, 250, 100)], [p(1, 250, 100)], new Set(), opts, vehicle);
    expect(guidance.certifiedChainCandidateCount).toBe(0);
    expect(guidance.chain).toMatchObject({ stationIds: [], destinationReachable: false });
    expect(guidance.frontierUnchecked).toEqual([]);
  });

  it('builds a valid ordered chain to the destination', () => {
    const guidance = buildReachabilityGuidance(300,
      [p(1, 120), p(2, 240)], [p(1, 120), p(2, 240)], new Set([1, 2]), opts, vehicle);
    expect(guidance.chain).toMatchObject({
      stationIds: [1, 2], cursorChainageKm: 240, destinationReachable: true,
    });
  });

  it('reports exhausted unchecked IDs without inventing another action', () => {
    const guidance = buildReachabilityGuidance(300,
      [p(1, 10), p(2, 20)], [], new Set([1, 2]), opts, vehicle);
    expect(guidance.initialUncheckedCount).toBe(0);
    expect(guidance.frontierUncheckedCount).toBe(0);
    expect(guidance.uncheckedCandidateCount).toBe(0);
  });

  it('keeps guidance advisory and free of occupancy language', () => {
    const guidance = buildReachabilityGuidance(300, [p(1, 10)], [], new Set(), opts, vehicle);
    const text = JSON.stringify(guidance);
    expect(guidance.advisoryOnly).toBe(true);
    expect(text).not.toMatch(/occupied|working-free|available|status/i);
  });
  it('accepts close-spaced certified stops with strict forward progress', () => {
    const tight = { ...opts, maxLegKm: 100.25 };
    const guidance = buildReachabilityGuidance(200,
      [p(1, 100), p(2, 100.5)], [p(1, 100), p(2, 100.5)], new Set([1, 2]), tight, vehicle);
    expect(guidance.initialReachKm).toBe(100.25);
    expect(guidance.chain).toMatchObject({
      stationIds: [1, 2], cursorChainageKm: 100.5, destinationReachable: true,
    });
  });

  it('excludes a certified stop whose detour makes every prior leg impossible', () => {
    const guidance = buildReachabilityGuidance(300,
      [p(1, 280, 400), p(2, 100), p(3, 200)],
      [p(1, 280, 400), p(2, 100), p(3, 200)], new Set([1, 2, 3]), opts, vehicle);
    expect(guidance.certifiedChainCandidateCount).toBe(2);
    expect(guidance.chain).toMatchObject({
      stationIds: [2, 3], cursorChainageKm: 200, destinationReachable: true,
    });
  });

  it('fails closed on invalid points and options', () => {
    const guidance = buildReachabilityGuidance(300,
      [p(-1, -5, 0), p(2, 10, Number.NaN)], [p(3, -10, 0)], new Set(),
      { ...opts, maxLegKm: Number.NaN }, vehicle);
    expect(guidance).toMatchObject({
      directDestinationReachable: false, initialReachKm: 0,
      initialUnchecked: [], chain: null, frontierUnchecked: [],
      uncheckedCandidateCount: 0, certifiedChainCandidateCount: 0,
    });
  });

  it('counts both prior and next detours in a chained leg', () => {
    const guidance = buildReachabilityGuidance(300,
      [p(1, 100, 20), p(2, 220, 10)],
      [p(1, 100, 20)], new Set([1]), opts, vehicle);
    expect(guidance.frontierUnchecked).toEqual([{ stationId: 2, legEstKm: 150 }]);
  });

  it('uses cumulative route geometry when it diverges from OSRM distance', () => {
    const guidance = buildReachabilityGuidance(300, [p(1, 10)], [], new Set(), opts, vehicle,
      [{ lat: 0, lon: 0 }, { lat: 0.18, lon: 0 }]);
    expect(guidance.routeDistanceKm).toBeCloseTo(20, 1);
    expect(guidance.directDestinationReachable).toBe(true);
  });

});
