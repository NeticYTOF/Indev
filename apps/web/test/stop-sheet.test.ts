import { describe, expect, it } from 'vitest';
import { plugSummary, renderChargerList, renderStopSheetMarkup } from '../src/stop-sheet.js';
import { normalizePlannedStation } from '../src/station-evidence.js';
import { tripLegs } from '../src/leg-distance.js';

function station(overrides: Record<string, unknown> = {}) {
  return {
    stationId: 42, name: 'Highway Hub', brand: 'statiq', lat: 27.5, lon: 76.6,
    address: 'NH48', city: 'Behror', hours: '24 hours', openText: 'Open now',
    rating: 4.4, reviewCount: 128, amenities: ['Cafe', 'Washroom'],
    stationUrl: 'https://example.com/s/42', fetchedAt: '2026-11-21T10:00:00Z', synthetic: false,
    chargers: [
      { chargerId: 7, name: 'DC 60', type: 'DC', kw: 60, pricePerKwh: 21, lastUsedOn: '20/11/2026',
        plugs: [
          { connectorId: 1, type: 'CCS-2', health: 'working-free', planningHealth: 'working-free', contradiction: false, faultNote: null },
          { connectorId: 2, type: 'CCS-2', health: 'working-occupied', planningHealth: 'working-occupied', contradiction: false, faultNote: null },
        ] },
      { chargerId: 8, name: 'DC 30', type: 'DC', kw: 30, pricePerKwh: null, lastUsedOn: null,
        plugs: [{ connectorId: 3, type: 'CCS-2', health: 'faulted', planningHealth: 'faulted', contradiction: false, faultNote: 'Error' }] },
    ],
    ...overrides,
  };
}

function planStop(overrides: Record<string, unknown> = {}) {
  return {
    station: station(), selectedCharger: { chargerId: 7, name: 'DC 60', kw: 60 },
    chainageKm: 198, legKm: 200, detourKm: 1.2, arriveSocPct: 18, leaveSocPct: 80,
    chargeKwh: 46, pricePerKwh: 21, estPriceInr: 966, chargeTimeMin: 38,
    arrivalEtaMin: 190, departureEtaMin: 228, ...overrides,
  };
}

describe('renderChargerList', () => {
  it('lists every charger and highlights the planned one', () => {
    const html = renderChargerList(station(), 7);
    expect(html.match(/<li class="charger-row[ "]/g)).toHaveLength(2);
    expect(html).toContain('charger-row is-selected');
    expect(html).toContain('Used for this plan');
    expect(html).toContain('60 kW');
    expect(html).toContain('Tariff unknown');
    expect(html).toContain('Faulted');
  });

  it('is honest when the charger list is unknown or empty', () => {
    expect(renderChargerList({ name: 'x' }, null)).toContain('Charger list Unknown');
    expect(renderChargerList(station({ chargers: [] }), null)).toContain('No chargers were listed');
  });

  it('escapes provider text', () => {
    const html = renderChargerList(station({ chargers: [{ chargerId: 9, name: '<img src=x onerror=alert(1)>', type: 'DC', kw: 50, plugs: [] }] }), null);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('compact rows omit the plug chips', () => {
    expect(renderChargerList(station(), 7, { compact: true })).not.toContain('charger-plugs');
  });
});

describe('plugSummary', () => {
  it('counts plugs by health', () => {
    const [first, second] = normalizePlannedStation(station()).chargers;
    expect(plugSummary(first!)).toBe('1 free · 1 occupied');
    expect(plugSummary(second!)).toBe('1 faulted');
  });
});

describe('renderStopSheetMarkup', () => {
  const stops = [planStop(), planStop({ station: station({ stationId: 43, name: 'Second' }), chainageKm: 405, legKm: 209 })];
  const legs = tripLegs({ originLabel: 'Delhi', destinationLabel: 'Jaipur', stops, totalDistanceKm: 600 });

  it('shows distances in and out, the battery plan and every charger', () => {
    const html = renderStopSheetMarkup({ index: 0, total: 2, source: 'plan', stop: stops[0], legIn: legs[0]!, legOut: legs[1]! });
    expect(html).toContain('Stop 1 of 2');
    expect(html).toContain('200 km');
    expect(html).toContain('From Delhi');
    expect(html).toContain('209 km');
    expect(html).toContain('To Second');
    expect(html).toContain('46 kWh');
    expect(html).toContain('Used for this plan');
    expect(html).toContain('href="https://example.com/s/42"');
    expect(html).toContain('data-ss-prev aria-label="Previous stop" disabled');
    expect(html).not.toContain('data-ss-next aria-label="Next stop" disabled');
  });

  it('drops unsafe links and escapes the station name', () => {
    const html = renderStopSheetMarkup({
      index: 0, total: 1, source: 'plan', legIn: null, legOut: null,
      stop: planStop({ station: station({ name: '"><script>x</script>', stationUrl: 'javascript:alert(1)', lat: 999 }) }),
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('>Directions<');
  });

  it('saved trips explain that no charger list is stored', () => {
    const html = renderStopSheetMarkup({
      index: 0, total: 1, source: 'saved', legIn: null, legOut: null,
      stop: { stationId: 42, name: 'Saved stop', lat: 27, lon: 76, chainageKm: 10, legKm: 10, detourKm: 0,
        arriveSocPct: 20, leaveSocPct: 80, chargeKwh: 40, pricePerKwh: null, estPriceInr: null, chargeTimeMin: 30 },
    });
    expect(html).toContain('not a charger list');
    expect(html).toContain('data-ss-fetch>');
  });

  it('disables live fetch without a valid station id', () => {
    const html = renderStopSheetMarkup({
      index: 0, total: 1, source: 'plan', legIn: null, legOut: null,
      stop: planStop({ station: station({ stationId: -1 }) }),
    });
    expect(html).toContain('Fetch live status unavailable');
  });
});
