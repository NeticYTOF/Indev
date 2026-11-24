import { describe, expect, it } from 'vitest';
import { cumulativeKm, formatLegKm, pointAtDistance, stopName, tripLegs } from '../src/leg-distance.js';

const stop = (name: string, chainageKm: number, legKm: number, detourKm = 1) =>
  ({ station: { name }, chainageKm, legKm, detourKm });

describe('tripLegs', () => {
  it('lists origin → stops → destination with authoritative leg km and the briefing final-leg math', () => {
    const legs = tripLegs({
      originLabel: 'Delhi', destinationLabel: 'Jaipur', totalDistanceKm: 600,
      stops: [stop('A', 198, 200), stop('B', 405, 209.5, 2)],
    });
    expect(legs.map((l) => [l.fromLabel, l.toLabel, l.km])).toEqual([
      ['Delhi', 'A', 200], ['A', 'B', 209.5], ['B', 'Jaipur', 197],
    ]);
    expect(legs[1]).toMatchObject({ startChainageKm: 198, endChainageKm: 405, toIndex: 1 });
    expect(legs[2]).toMatchObject({ toIndex: 2, endChainageKm: 600 });
  });

  it('a stop-free trip is one leg of the total distance', () => {
    expect(tripLegs({ originLabel: 'A', destinationLabel: 'B', totalDistanceKm: 120, stops: [] }))
      .toEqual([{ toIndex: 0, fromLabel: 'A', toLabel: 'B', km: 120, startChainageKm: 0, endChainageKm: 120 }]);
  });

  it('never invents numbers from malformed data', () => {
    const legs = tripLegs({
      originLabel: '', destinationLabel: null, totalDistanceKm: Number.NaN,
      stops: [{ station: { name: '  ' }, legKm: -4, chainageKm: 'x' }, null],
    });
    expect(legs.map((l) => l.km)).toEqual([null, null, null]);
    expect(legs[0]!.fromLabel).toBe('Start');
    expect(legs[0]!.toLabel).toBe('Unknown station');
    expect(legs[2]!.toLabel).toBe('Destination');
  });

  it('reads saved station refs by name', () => {
    expect(stopName({ name: 'Saved stop' })).toBe('Saved stop');
  });
});

describe('formatLegKm', () => {
  it('rounds long legs and keeps one decimal for short ones', () => {
    expect(formatLegKm(207.4)).toBe('207 km');
    expect(formatLegKm(12.34)).toBe('12.3 km');
    expect(formatLegKm(null)).toBe('Unknown');
  });
});

describe('route geometry helpers', () => {
  const line: Array<[number, number]> = [[0, 0], [0, 1], [0, 2]];
  it('measures cumulative distance along the route', () => {
    const cum = cumulativeKm(line);
    expect(cum[0]).toBe(0);
    expect(cum[1]).toBeCloseTo(111.2, 0);
    expect(cum[2]).toBeCloseTo(222.4, 0);
  });

  it('finds the point at a distance, scaling plan km onto the drawn length', () => {
    const mid = pointAtDistance(line, 111.195)!;
    expect(mid[1]).toBeCloseTo(1, 2);
    const scaled = pointAtDistance(line, 50, 100)!; // half of a 100 km plan
    expect(scaled[1]).toBeCloseTo(1, 2);
    expect(pointAtDistance(line, 1e9)![1]).toBeCloseTo(2, 5);
    expect(pointAtDistance([[0, 0]], 5)).toBeNull();
  });
});
