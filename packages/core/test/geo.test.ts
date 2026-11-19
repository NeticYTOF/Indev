import { describe, expect, it } from 'vitest';
import {
  type Coords,
  cumulativeKm,
  haversineKm,
  pointAtChainage,
  pointToPolylineKm,
  pointToSegmentKm,
  projectOntoPolyline,
} from '../src/geo.js';

const DELHI: Coords = { lat: 28.6139, lon: 77.209 };
const JAIPUR: Coords = { lat: 26.9124, lon: 75.7873 };

describe('haversineKm', () => {
  it('matches known city-pair distances', () => {
    // Delhi -> Jaipur great-circle is ~238 km
    const d = haversineKm(DELHI, JAIPUR);
    expect(d).toBeGreaterThan(233);
    expect(d).toBeLessThan(243);
  });

  it('is zero for identical points', () => {
    expect(haversineKm(DELHI, DELHY2())).toBe(0);
  });
});

function DELHY2(): Coords {
  return { ...DELHI };
}

describe('pointToSegmentKm', () => {
  const a: Coords = { lat: 28.0, lon: 77.0 };
  const b: Coords = { lat: 28.0, lon: 77.1 }; // ~10.7 km east

  it('is near zero for a point on the segment', () => {
    const mid: Coords = { lat: 28.0, lon: 77.05 };
    expect(pointToSegmentKm(mid, a, b)).toBeLessThan(0.05);
  });

  it('clamps to segment ends for points beyond it', () => {
    const eastFar: Coords = { lat: 28.0, lon: 77.3 };
    const d = pointToSegmentKm(eastFar, a, b);
    const direct = haversineKm(eastFar, b);
    expect(Math.abs(d - direct)).toBeLessThan(0.05);
  });
});

describe('pointToPolylineKm', () => {
  // straight east line: (28.0, 77.0) -> (28.0, 77.2) via (77.1)
  const line: Coords[] = [
    { lat: 28.0, lon: 77.0 },
    { lat: 28.0, lon: 77.1 },
    { lat: 28.0, lon: 77.2 },
  ];

  it('finds perpendicular distance for a point beside the line', () => {
    const p: Coords = { lat: 28.05, lon: 77.15 }; // 0.05 deg north of the line
    const d = pointToPolylineKm(p, line);
    // 0.05 deg lat = 5.566 km
    expect(d).toBeGreaterThan(5.4);
    expect(d).toBeLessThan(5.8);
  });

  it('handles single-point polyline', () => {
    const d = pointToPolylineKm({ lat: 28.1, lon: 77.0 }, [DELHI]);
    expect(d).toBeGreaterThan(0);
  });
});

describe('chainage helpers', () => {
  // straight east line, two equal ~9.86 km segments
  const line: Coords[] = [
    { lat: 28.0, lon: 77.0 },
    { lat: 28.0, lon: 77.1 },
    { lat: 28.0, lon: 77.2 },
  ];
  const cum = cumulativeKm(line);
  const total = cum[2] as number;

  it('cumulative sums segment lengths', () => {
    expect(cum).toHaveLength(3);
    expect(cum[0]).toBe(0);
    expect(total).toBeGreaterThan(19);
    expect(total).toBeLessThan(20);
  });

  it('projects a point to the correct foot and chainage', () => {
    const p: Coords = { lat: 28.01, lon: 77.15 }; // north of the line, at 3/4 route
    const proj = projectOntoPolyline(p, line);
    expect(proj.chainageKm).toBeGreaterThan(total * 0.75 - 0.3);
    expect(proj.chainageKm).toBeLessThan(total * 0.75 + 0.3);
    // 0.01 deg lat = 1.11 km
    expect(proj.distanceKm).toBeGreaterThan(0.9);
    expect(proj.distanceKm).toBeLessThan(1.3);
  });

  it('interpolates points by chainage', () => {
    const mid = pointAtChainage(line, cum, total / 2);
    expect(mid.lon).toBeCloseTo(77.1, 4);
    expect(mid.lat).toBeCloseTo(28.0, 6);
    const start = pointAtChainage(line, cum, -5);
    expect(start.lon).toBeCloseTo(77.0, 4);
    const end = pointAtChainage(line, cum, 999);
    expect(end.lon).toBeCloseTo(77.2, 4);
  });
});
