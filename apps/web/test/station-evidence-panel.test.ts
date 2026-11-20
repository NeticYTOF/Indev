import { describe, expect, it } from 'vitest';
import { renderStationEvidencePanel } from '../src/station-evidence-panel.js';
import type { PlanStop } from '@indeev/core';

function plannedStop(): PlanStop {
  return {
    station: {
      stationId: 42, name: '<img src=x onerror=proof>', brand: 'statiq', lat: 27, lon: 76,
      address: null, city: null, hours: null, openText: null,
      rating: null, reviewCount: null, reliability: null,
      fetchedAt: '2026-11-20T10:00:00.000Z', synthetic: true,
      amenities: [], stationUrl: 'javascript:alert(1)', navUrl: null,
      chargers: [{
        chargerId: 7, name: 'DC 60', type: 'DC', kw: 60, pricePerKwh: 22.75,
        lastUsedOn: '18/11/2026',
        plugs: [{ connectorId: 1, type: 'CCS-2', health: 'working-occupied', contradiction: false }],
      }],
    },
    chainageKm: 100, legKm: 102, detourKm: 2,
    arriveSocPct: 24, leaveSocPct: 80, chargeKwh: 42.7,
    pricePerKwh: 22.75, estPriceInr: 972, chargeTimeMin: 42,
    arrivalEtaMin: 90, departureEtaMin: 132,
  };
}

describe('station evidence panel', () => {
  it('renders planned and fetched sections without trusting external strings', () => {
    const stop = plannedStop();
    const markup = renderStationEvidencePanel({
      plannedStation: stop.station,
      plannedFacts: {
        tariffPerKwh: stop.pricePerKwh, chargeKwh: stop.chargeKwh,
        chargeTimeMin: stop.chargeTimeMin, arriveSocPct: stop.arriveSocPct,
        leaveSocPct: stop.leaveSocPct,
      },
    });
    expect(markup).toContain('<details');
    expect(markup).toContain('Planned snapshot from the trip');
    expect(markup).toContain('Manual station status');
    expect(markup).toContain('Rs. 22.75/kWh');
    expect(markup).toContain('Working · occupied');
    expect(markup).toContain('Reliability: unavailable');
    expect(markup).toContain('&lt;img src=x onerror=proof&gt;');
    expect(markup).not.toContain('<img src=x onerror=proof>');
    expect(markup).not.toContain('javascript:');
    expect(markup).toContain('No current status requested.');
    expect(markup).not.toContain('gradient');
  });

  it('keeps known zero and unknown malformed planned facts separate', () => {
    const markup = renderStationEvidencePanel({
      savedStation: {
        stationId: 9, name: 'Saved stop', lat: 0, lon: 0,
        chainageKm: 50, legKm: 52, detourKm: 2,
        arriveSocPct: 22, leaveSocPct: 60, chargeKwh: 30,
        pricePerKwh: 0, estPriceInr: 0, chargeTimeMin: 25,
      },
      plannedFacts: {
        tariffPerKwh: 0, chargeKwh: Number.NaN, chargeTimeMin: -2,
        arriveSocPct: 140, leaveSocPct: 60,
      },
    });
    expect(markup).toContain('Rs. 0/kWh');
    expect(markup).toContain('30 kWh');
    expect(markup).toContain('Unknown → 60%');
  });
});
