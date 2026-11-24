import { describe, expect, it } from 'vitest';
import { hydrateSelective } from '@indeev/core';

const candidate = {
  stationId: 42, name: 'Shape site', lat: 1, lon: 0,
  chainageKm: 100, offRouteKm: 0,
  marker: { stationId: 42, name: 'Shape site', lat: 1, lon: 0, address: null,
    accessType: 1, isCommunityListed: false, stationUrl: '' },
};

function response(station: unknown) {
  return { ok: true, live: true, retained: false, source: 'test', station } as never;
}

const validConnector = { displayId: 1, connectorId: 1, type: 'CCS-2', status: 'available', available: true, note: null };
const validCharger = { chargerId: 1, name: '60 kW', type: 'DC', kw: 60, pricePerKwh: 20,
  currency: 'INR', lastUsedOn: null, connectors: [validConnector] };

function stationWith(chargers: unknown) {
  return {
    stationId: 42, name: 'Shape site', lat: 1, lon: 0, address: null, area: null,
    city: null, landmark: null, hours: null, openText: null, rating: null,
    reviewCount: null, accessType: 'public', navUrl: '', stationUrl: '',
    imageUrl: null, amenities: [], stepsToReach: null, chargers,
    summary: { anyDc: true, ccs2Dc: true, maxDcCcs2Kw: 60, availableNow: true, statusCounts: null },
  };
}

describe('selective hydration fails closed on malformed evidence', () => {
  it.each([
    ['null charger', [null], 'schema_invalid'],
    ['null connector', [{ ...validCharger, connectors: [null] }], 'schema_invalid'],
    ['string power', [{ ...validCharger, kw: '60' }], 'schema_invalid'],
    ['object type', [{ ...validCharger, type: {} }], 'schema_invalid'],
    ['missing connectors', [{ ...validCharger, connectors: undefined }], 'missing_evidence'],
    ['object note', [{ ...validCharger, connectors: [{ ...validConnector, note: {} }] }], 'schema_invalid'],
    ['missing charger id', [{ ...validCharger, chargerId: undefined }], 'schema_invalid'],
    ['missing charger name', [{ ...validCharger, name: undefined }], 'schema_invalid'],
  ])('%s', (_name, chargers, reason) => {
    const result = hydrateSelective(candidate as never, response(stationWith(chargers)), new Date(), 100);
    expect(result.candidate).toBeNull();
    expect(result.reasons).toContain(reason);
    expect(result.warnings.join(' ')).not.toMatch(/occupied|healthy|faulted/i);
  });

  it('unknown-power sibling does not mask a certified under-cap charger', () => {
    const chargers = [
      { ...validCharger, kw: 60 },
      { ...validCharger, chargerId: 2, kw: null },
      { ...validCharger, chargerId: 3, kw: 120 },
    ];
    const result = hydrateSelective(candidate as never, response(stationWith(chargers)), new Date(), 100);
    expect(result.candidate?.selectedCharger?.kw).toBe(60);
    expect(result.reasons).toEqual([]);
  });
});

describe('selective hydration planning policy', () => {
  it('certifies a station whose only plugs are available with a positive fault note', () => {
    const chargers = [{ ...validCharger,
      connectors: [{ ...validConnector, note: 'Faulted' }] }];
    const result = hydrateSelective(candidate as never,
      response(stationWith(chargers)), new Date(), 100);
    expect(result.candidate).not.toBeNull();
    expect(result.reasons).toEqual([]);
    expect(result.candidate?.summary.faultNoted).toBe(1);
  });

  it('keeps a healthy sibling certified and occupied working connectors usable', () => {
    const chargers = [
      { ...validCharger, chargerId: 1,
        connectors: [{ ...validConnector, note: 'Faulted' }, validConnector] },
      { ...validCharger, chargerId: 2,
        connectors: [{ ...validConnector, status: 'charging', available: false, note: 'Charging' }] },
    ];
    const result = hydrateSelective(candidate as never,
      response(stationWith(chargers)), new Date(), 100);
    expect(result.reasons).toEqual([]);
    expect(result.candidate?.summary.usable).toBeGreaterThanOrEqual(2);
  });
});
