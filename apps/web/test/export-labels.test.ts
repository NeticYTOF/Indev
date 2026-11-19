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
});
