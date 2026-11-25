import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chargeSeries } from '../src/ui/charge-chart';
import { subsetBasecoatStyle } from '../basecoat-subset';

const plan = {
  startSocPct: 90,
  origin: { label: 'Pune' },
  destination: { label: 'Goa' },
  totals: { distanceKm: 450, finalSocPct: 34 },
  stops: [
    { chainageKm: 180, arriveSocPct: 41, leaveSocPct: 80, station: { name: 'Kolhapur Hub' } },
    { chainageKm: 330, arriveSocPct: 38, leaveSocPct: 75, station: { name: 'Belgaum Plaza' } },
  ],
};

describe('chargeSeries', () => {
  it('builds start, a dip and jump per stop, and the destination, from plan facts', () => {
    const s = chargeSeries(plan);
    expect(s).not.toBeNull();
    expect(s!.map((p) => [p.km, p.soc, p.kind])).toEqual([
      [0, 90, 'start'],
      [180, 41, 'arrive'],
      [180, 80, 'leave'],
      [330, 38, 'arrive'],
      [330, 75, 'leave'],
      [450, 34, 'destination'],
    ]);
    expect(s![1]!.label).toBe('Kolhapur Hub');
    expect(s![5]!.label).toBe('Goa');
  });

  it('draws a no-stop route as a single straight run', () => {
    const s = chargeSeries({ ...plan, stops: [] });
    expect(s!.map((p) => p.kind)).toEqual(['start', 'destination']);
  });

  it('refuses to draw when a fact the line needs is missing', () => {
    expect(chargeSeries({ ...plan, startSocPct: undefined })).toBeNull();
    expect(chargeSeries({ ...plan, totals: { distanceKm: 450 } })).toBeNull();
    expect(chargeSeries({ ...plan, totals: { distanceKm: 0, finalSocPct: 30 } })).toBeNull();
    expect(chargeSeries({ ...plan, stops: null })).toBeNull();
    expect(chargeSeries({ ...plan, stops: [{ chainageKm: 100, arriveSocPct: 40 }] })).toBeNull();
  });

  it('refuses out-of-range or out-of-order readings instead of guessing', () => {
    expect(chargeSeries({ ...plan, startSocPct: 120 })).toBeNull();
    expect(chargeSeries({ ...plan, stops: [plan.stops[1], plan.stops[0]] })).toBeNull();
    expect(chargeSeries({ ...plan, stops: [{ ...plan.stops[0], chainageKm: 900 }] })).toBeNull();
    expect(chargeSeries({ ...plan, stops: [{ ...plan.stops[0], arriveSocPct: Number.NaN }] })).toBeNull();
  });
});

describe('basecoat subset', () => {
  const require = createRequire(import.meta.url);
  const vega = readFileSync(join(dirname(require.resolve('basecoat-css/package.json')), 'dist', 'styles', 'vega.css'), 'utf8');
  const out = subsetBasecoatStyle(vega);

  it('keeps only the components the app renders, inside one balanced layer', () => {
    expect(out.startsWith('@layer components {')).toBe(true);
    expect((out.match(/\{/g) ?? []).length).toBe((out.match(/\}/g) ?? []).length);
    for (const kept of ['/* Button */', '/* Input */', '/* Native Select */', '/* Badge */', '/* Tooltip */']) {
      expect(out).toContain(kept);
    }
    for (const dropped of ['/* Sidebar */', '/* Combobox */', '/* Dialog */', '/* Accordion */', '/* Input OTP */']) {
      expect(out).not.toContain(dropped);
    }
    expect(out.length).toBeLessThan(vega.length / 4);
  });

  it('matches the committed generated file', () => {
    const committed = readFileSync(new URL('../src/ui/generated/basecoat-vega.css', import.meta.url), 'utf8');
    expect(committed).toBe(out);
  });
});
