import { describe, expect, it } from 'vitest';
import type { TripPlan } from '@indeev/core';
import { buildAnimatedExportSvg } from '../src/export.js';

function plan(origin: string, destination: string): TripPlan {
  return {
    geometry: [{ lat: 28, lon: 77 }, { lat: 27, lon: 78 }],
    stops: [], origin: { label: origin }, destination: { label: destination },
    vehicle: { label: 'Tata Harrier EV', realWorldRangeKm: 450 },
    totals: { totalTimeMin: 100, chargeTimeMin: 0, finalSocPct: 40, estPriceInr: null },
    source: 'synthetic', status: 'ok', routeDistanceKm: 100,
    createdAt: '2026-11-19T18:00:00Z',
  } as TripPlan;
}

const statValues = (svg: string): string[] => [...svg.matchAll(/<g class="stat"[\s\S]*?<text y="24"[^>]*>(.*?)<\/text>/g)].map(match => match[1] ?? '');

describe('export header labels', () => {
  it('keeps short endpoint labels whole without forced spacing', () => {
    const svg = buildAnimatedExportSvg(plan('Delhi', 'Jaipur'));
    const title = svg.split('\n').find(line => line.includes('font-size="30"'))!;
    expect(title).toContain('Delhi → Jaipur</text>');
    expect(title).not.toContain('textLength');
    expect(title).not.toContain('…');
  });

  it('escapes full labels in metadata and visible label text', () => {
    const svg = buildAnimatedExportSvg(plan('<Delhi & airport>', 'Jaipur "east"'));
    expect(svg).toContain('<title>&lt;Delhi &amp; airport&gt; → Jaipur &quot;east&quot;</title>');
    expect(svg).not.toContain('<Delhi');
  });

  it('shortens code points without leaving broken surrogate halves', () => {
    const svg = buildAnimatedExportSvg(plan('🚙'.repeat(60), 'Jaipur'));
    expect(svg).toContain(`${'🚙'.repeat(35)}… → Jaipur</text>`);
    expect(svg).toContain(`<title>${'🚙'.repeat(60)} → Jaipur</title>`);
    expect(svg.isWellFormed()).toBe(true);
  });

  for (const [label, patch, totals] of [
    ['negative finite scalars', { routeDistanceKm: -1 }, { totalTimeMin: -1, chargeTimeMin: -1, estPriceInr: -1, finalSocPct: -1 }],
    ['null scalars', { routeDistanceKm: null }, { totalTimeMin: null, chargeTimeMin: null, estPriceInr: null, finalSocPct: null }],
    ['wrong scalar types', { routeDistanceKm: '100' }, { totalTimeMin: '100', chargeTimeMin: '0', estPriceInr: '40', finalSocPct: '40' }],
    ['unsafe finite scalars and SOC 140', { routeDistanceKm: Number.MAX_SAFE_INTEGER + 1 }, { totalTimeMin: Number.MAX_SAFE_INTEGER + 1, chargeTimeMin: Number.MAX_SAFE_INTEGER + 1, estPriceInr: Number.MAX_SAFE_INTEGER + 1, finalSocPct: 140 }],
  ] as const) {
    it(`keeps ${label} and a bad creation date unavailable in SVG stats`, () => {
      const base = plan('Delhi', 'Jaipur');
      const broken = { ...base, ...patch, createdAt: label === 'wrong scalar types' ? 42 : 'not-a-date', totals: { ...base.totals, ...totals } };
      const svg = buildAnimatedExportSvg(broken as unknown as TripPlan);
      expect(statValues(svg)).toEqual(['—', '—', '0', '—', '—', '—']);
      expect(svg).toContain('IndEV — planned —');
    });
  }

  it('keeps valid zero facts and the planned date visible', () => {
    const base = plan('Delhi', 'Jaipur');
    const svg = buildAnimatedExportSvg({ ...base, routeDistanceKm: 0, totals: { ...base.totals, totalTimeMin: 0, chargeTimeMin: 0, estPriceInr: 0, finalSocPct: 0 } });
    expect(statValues(svg)).toEqual(['0 km', '0 min', '0', '0 min', 'Rs. 0', '0%']);
    expect(svg).toContain(`IndEV — planned ${new Date(base.createdAt).toLocaleDateString('en-IN')}`);
  });

  it('keeps normal control stats unchanged', () => {
    const svg = buildAnimatedExportSvg(plan('Delhi', 'Jaipur'));
    expect(statValues(svg)).toEqual(['100 km', '1 h 40 min', '0', '0 min', '—', '40%']);
  });
});
