import { describe, expect, it } from 'vitest';
import {
  buildTripComparison,
  buildTripComparisonHtml,
  renderTripComparisonMarkup,
  type TripComparison,
} from '../src/trip-compare.js';

function trip(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'fixture',
    name: 'Saved trip',
    createdAt: '2026-11-20T10:00:00Z',
    source: 'live',
    status: 'ok',
    origin: { label: 'Delhi', lat: 28.6139, lon: 77.209 },
    destination: { label: 'Jaipur', lat: 26.9124, lon: 75.7873 },
    vehicle: {
      label: 'Harrier', catalogId: 'tata-harrier-ev-75',
      batteryKwh: 75, claimedRangeKm: 627, realWorldRangeKm: 300,
    },
    routeDistanceKm: 400,
    routeDurationMin: 400,
    geometry: [[28.6139, 77.209], [27, 76], [26.9124, 75.7873]],
    stations: [{
      stationId: 42, name: 'DC stop', lat: 27, lon: 76,
      chainageKm: 200, legKm: 202, detourKm: 2,
      arriveSocPct: 25, leaveSocPct: 80, chargeKwh: 41.25,
      pricePerKwh: 0, estPriceInr: 0, chargeTimeMin: 45,
    }],
    totals: {
      distanceKm: 400, driveTimeMin: 340, totalTimeMin: 400, chargeTimeMin: 45,
      chargeKwh: 41.25, estPriceInr: 0, finalSocPct: 12,
    },
    ...overrides,
  };
}

function diff(comparison: TripComparison, key: TripComparison['diffs'][number]['key']) {
  return comparison.diffs.find((entry) => entry.key === key);
}

describe('saved trip comparison model', () => {
  it('preserves exact stored vehicle facts and emits signed B minus A differences', () => {
    const comparison = buildTripComparison([
      trip({
        vehicle: { label: 'Harrier 75.01', catalogId: 'x', batteryKwh: 75.01, claimedRangeKm: 627, realWorldRangeKm: 300 },
        routeDistanceKm: 400.2,
        totals: { distanceKm: 400, driveTimeMin: 340, totalTimeMin: 400, chargeTimeMin: 45, chargeKwh: 40, estPriceInr: 100, finalSocPct: 12 },
      }),
      trip({
        vehicle: { label: 'Other', catalogId: null, batteryKwh: 75, claimedRangeKm: null, realWorldRangeKm: 280 },
        routeDistanceKm: 420,
        totals: { distanceKm: 420, driveTimeMin: 350, totalTimeMin: 465, chargeTimeMin: 60, chargeKwh: 48, estPriceInr: 180, finalSocPct: 18 },
      }),
    ]);

    expect(comparison.sides[0]?.vehicle.batteryDisplay).toBe('75.01 kWh');
    expect(comparison.sides[0]?.vehicle.realWorldDisplay).toBe('300 km');
    expect(comparison.sides[1]?.vehicle.realWorldDisplay).toBe('280 km');
    expect(comparison.sides[0]?.vehicle.claimedDisplay).toBe('627 km (mfr)');
    expect(comparison.sides[1]?.vehicle.claimedDisplay).toBe('Unknown');
    expect(diff(comparison, 'distanceKm')?.display).toBe('+19.8 km');
    expect(diff(comparison, 'energyKwh')?.display).toBe('+8 kWh');
    expect(diff(comparison, 'totalTimeMin')?.display).toBe('+1 h 5 min');
    expect(diff(comparison, 'finalSocPct')?.display).toBe('+6 pp');
    expect(comparison.differentVehicle).toBe(true);
    expect(comparison.contextNotes.join(' ')).toContain('Real-world range differs.');
    expect(renderTripComparisonMarkup(comparison)).toContain('No automatic best route.');
  });

  it('distinguishes known zero from Unknown and a missing list from an empty list', () => {
    const comparison = buildTripComparison([
      trip({
        stations: [],
        totals: { distanceKm: 400, driveTimeMin: 340, totalTimeMin: 400, chargeTimeMin: 0, chargeKwh: 0, estPriceInr: 0, finalSocPct: 0 },
      }),
      trip({
        stations: undefined,
        totals: { distanceKm: 400, driveTimeMin: 340, totalTimeMin: 400 },
      }),
    ]);
    const a = comparison.sides[0];
    const b = comparison.sides[1];
    expect(a?.metrics.costInr.display).toBe('Rs. 0');
    expect(a?.metrics.finalSocPct.display).toBe('0%');
    expect(a?.metrics.stopCount).toMatchObject({ value: 0, display: '0' });
    expect(b?.metrics.costInr.display).toBe('Unknown');
    expect(b?.metrics.finalSocPct.display).toBe('Unknown');
    expect(b?.metrics.stopCount).toMatchObject({ value: null, display: 'Unknown' });
    expect(b?.stopsKnown).toBe(false);
    expect(diff(comparison, 'costInr')?.value).toBeNull();
    expect(diff(comparison, 'stopCount')?.value).toBeNull();
    const markup = renderTripComparisonMarkup(comparison);
    expect(markup).toContain('Rs. 0');
    expect(markup).toContain('No charging stops stored for this trip.');
    expect(markup).toContain('Stored charging stop itinerary is Unknown.');
    expect(markup).toContain('Not comparable');
  });

  it('keeps malformed stop rows and escapes hostile stored labels', () => {
    const hostile = '<img src=x onerror=stationProof>';
    const comparison = buildTripComparison([
      trip({
        name: hostile,
        origin: { label: hostile, lat: 'bad', lon: 77 },
        source: 'synthetic',
        status: 'degraded',
        stations: [null, { stationId: 42, name: 'DC stop', pricePerKwh: -1, chargeKwh: 'bad' }],
      }),
      trip(),
    ]);
    const a = comparison.sides[0];
    expect(a?.stops).toHaveLength(2);
    expect(a?.stops[0]?.name).toBe('Unknown station');
    expect(a?.stops[0]?.tariff.display).toBe('Unknown');
    expect(a?.stops[1]?.name).toBe('DC stop');
    expect(a?.stops[1]?.stationId).toBe(42);
    expect(a?.stops[1]?.tariff.display).toBe('Unknown');
    expect(a?.origin).toBeNull();
    expect(a?.synthetic).toBe(true);
    expect(a?.degraded).toBe(true);
    const markup = renderTripComparisonMarkup(comparison);
    expect(markup).not.toContain(hostile);
    expect(markup).toContain('&lt;img src=x onerror=stationProof&gt;');
    expect(markup).toContain('Synthetic');
    expect(markup).toContain('Degraded');
    const firstColumn = markup.split('<article class="compare-card" data-compare-card="b"')[0] ?? markup;
    const ordinals = [...firstColumn.matchAll(/<span class="compare-stop-order">(\d+)<\/span>/g)]
      .map((match) => match[1]);
    expect(ordinals).toEqual(['1', '2']);
    expect(markup).toContain('<strong>Unknown station</strong>');
    expect(markup).toContain('<strong>DC stop</strong>');
    expect(markup).toContain('Station 42');
  });

  it('builds a standalone gradient-free export from the same presentation data', () => {
    const comparison = buildTripComparison([trip(), trip({ name: 'Alternative' })]);
    const html = buildTripComparisonHtml(comparison);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('@media print');
    expect(html).toContain('No automatic best route.');
    expect(html).toContain('Vehicle as stored');
    expect(html).not.toContain('gradient');
  });

  it('refuses a comparison without exactly two trips', () => {
    expect(() => buildTripComparison([])).toThrow('Exactly two saved trips');
    expect(() => buildTripComparison([trip()])).toThrow('Exactly two saved trips');
  });
});
