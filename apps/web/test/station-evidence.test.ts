import { describe, expect, it } from 'vitest';
import type { PlanStop } from '@indeev/core';
import {
  displayEvidence,
  normalizeFetchedStationResponse,
  normalizePlannedStation,
  plugHealthLabel,
  stationMatchesId,
  type StationEvidence,
} from '../src/station-evidence.js';

function plannedStop(): PlanStop {
  return {
    station: {
      stationId: 42, name: 'Planned Stop', brand: 'statiq', lat: 27, lon: 76,
      address: 'NH 48', city: 'Kotputli', hours: '24h', openText: 'Open',
      rating: 4.2, reviewCount: 128, reliability: null,
      fetchedAt: '2026-11-20T10:00:00.000Z', synthetic: true,
      amenities: ['Cafe'], stationUrl: 'https://example.test/station', navUrl: null,
      chargers: [{
        chargerId: 7, name: 'DC 60', type: 'DC', kw: 60, pricePerKwh: 22.75,
        lastUsedOn: '18/11/2026',
        plugs: [
          { connectorId: 1, type: 'CCS-2', health: 'working-free', contradiction: false },
          { connectorId: 2, type: 'CCS-2', health: 'faulted', contradiction: false },
        ],
      }],
    },
    chainageKm: 100, legKm: 102, detourKm: 2,
    arriveSocPct: 24, leaveSocPct: 80, chargeKwh: 42.7,
    pricePerKwh: 22.75, estPriceInr: 972, chargeTimeMin: 42,
    arrivalEtaMin: 90, departureEtaMin: 132,
  };
}

function fetchedBody(overrides: Record<string, unknown> = {}) {
  return {
    station: {
      stationId: 42, name: 'Fetched Stop', address: null, city: null,
      hours: null, openText: null, rating: 4, reviewCount: 0, reliability: null,
      fetchedAt: '2026-11-20T11:00:00.000Z',
      ccs2: {
        total: 2, usable: 1, free: 1, occupied: 0, uncertain: 0, faulted: 1,
        offline: 0, maxKw: 60, pricePerKwh: 22.75, hasContradiction: false, isUsable: true,
      },
      chargers: [{
        chargerId: 7, name: 'DC 60', type: 'DC', kw: 60, pricePerKwh: 22.75,
        lastUsedOn: '18/11/2026',
        connectors: [
          { connectorId: 1, type: 'CCS-2', status: 'available', available: true, note: null },
          { connectorId: 2, type: 'CCS-2', status: 'faulted', available: false, note: 'Faulted' },
        ],
      }],
      ...overrides,
    },
  };
}

describe('station evidence boundary', () => {
  it('normalizes planned plugs without mutating the plan station', () => {
    const stop = plannedStop();
    const evidence = normalizePlannedStation(stop.station);
    expect(evidence.sourceKind).toBe('planned');
    expect(evidence.synthetic).toBe(true);
    expect(evidence.connectorTotal).toBe(2);
    expect(evidence.chargers[0]).toMatchObject({
      chargerId: 7, kw: 60, pricePerKwh: 22.75, lastUsedOn: '18/11/2026',
    });
    expect(evidence.chargers[0]?.connectors.map((c) => c.health)).toEqual(['working-free', 'faulted']);
    expect(stop.station.chargers[0]?.plugs).toHaveLength(2);
    expect(displayEvidence(evidence.maxKw, ' kW')).toBe('60 kW');
    expect(plugHealthLabel('faulted')).toBe('Faulted');
  });

  it('classifies raw fetched connector status through the core rules', () => {
    const evidence = normalizeFetchedStationResponse(fetchedBody());
    expect(evidence).not.toBeNull();
    expect(evidence?.sourceKind).toBe('fetched');
    expect(evidence?.synthetic).toBe(false);
    expect(evidence?.fetchedAt).toBe('2026-11-20T11:00:00.000Z');
    expect(evidence?.chargers[0]?.connectors.map((c) => c.health)).toEqual(['working-free', 'faulted']);
    expect(evidence?.counts).toMatchObject({ usable: 1, free: 1, faulted: 1 });
    expect(stationMatchesId(evidence as StationEvidence, 42)).toBe(true);
  });

  it('does not infer aggregate tariff or availability from malformed evidence', () => {
    const body = fetchedBody();
    const station = body.station as Record<string, unknown>;
    station.ccs2 = { total: '2', usable: 0, maxKw: -1, pricePerKwh: '22.75' };
    station.chargers = [{
      chargerId: 7, name: 'DC', type: 'DC', kw: 60, pricePerKwh: 22.75,
      connectors: [{ connectorId: 1, type: 'CCS-2', status: 42, available: 'yes', note: 7 }],
    }];
    const evidence = normalizeFetchedStationResponse(body);
    expect(evidence?.counts.total).toBeNull();
    expect(evidence?.counts.usable).toBe(0);
    expect(evidence?.maxKw).toBeNull();
    expect(evidence?.tariffPerKwh).toBeNull();
    expect(evidence?.chargers[0]?.connectors[0]).toMatchObject({
      health: 'unknown', status: null, available: null, invalidAvailability: true,
    });
    expect(evidence?.warnings.length).toBeGreaterThan(0);
    expect(displayEvidence(evidence?.tariffPerKwh)).toBe('Unknown');
    expect(evidence?.counts.total).toBeNull();
  });

  it.each(['yes', 0, { value: true }])('revokes plausible status when availability is malformed: %j', (available) => {
    const body = fetchedBody();
    const station = body.station as Record<string, unknown>;
    station.chargers = [{
      chargerId: 7, name: 'DC', type: 'DC', kw: 60, pricePerKwh: 22.75,
      connectors: [{ connectorId: 1, type: 'CCS-2', status: 'available', available, note: null }],
    }];
    const evidence = normalizeFetchedStationResponse({ ...body, live: true, retained: false });
    const connector = evidence?.chargers[0]?.connectors[0];
    expect(connector?.health).toBe('uncertain');
    expect(connector?.contradiction).toBe(true);
    expect(connector?.invalidAvailability).toBe(true);
    expect(connector?.available).toBeNull();
  });

  it('never trusts a supplied fetched health label over raw status', () => {
    const body = fetchedBody();
    const station = body.station as Record<string, unknown>;
    station.chargers = [{
      chargerId: 7, name: 'DC', type: 'DC', kw: 60, pricePerKwh: 22.75,
      connectors: [{ connectorId: 1, type: 'CCS-2', status: 'faulted', available: false, note: null, health: 'working-free' }],
    }];
    const evidence = normalizeFetchedStationResponse({ ...body, live: true, retained: false });
    expect(evidence?.chargers[0]?.connectors[0]?.health).toBe('faulted');
    expect(evidence?.warnings.join(' ')).toContain('conflicts with its status');
  });

  it('requires safe integer counts and distinguishes a missing charger list from an empty one', () => {
    const body = fetchedBody();
    const station = body.station as Record<string, unknown>;
    station.ccs2 = { total: 2.5, usable: 1, free: 1, occupied: 0 };
    const fractional = normalizeFetchedStationResponse({ ...body, live: true, retained: false });
    expect(fractional?.counts.total).toBeNull();
    expect(fractional?.counts.usable).toBe(1);
    expect(fractional?.chargersMissing).toBe(false);

    const absent = normalizeFetchedStationResponse({ live: true, retained: false, station: { stationId: 42, name: 'No list' } });
    expect(absent?.chargersMissing).toBe(true);
    expect(absent?.warnings.join(' ')).toContain('Charger list is Unknown');
  });

  it('marks retained or non-live bodies as retained and rejects malformed fetch times', () => {
    const retained = normalizeFetchedStationResponse({ ...fetchedBody(), live: false, retained: true });
    expect(retained?.provenance).toBe('retained');
    expect(retained?.warnings.join(' ')).toContain('retained');

    const body = fetchedBody();
    const station = body.station as Record<string, unknown>;
    station.fetchedAt = 'not a date';
    const badTime = normalizeFetchedStationResponse({ ...body, live: true, retained: false });
    expect(badTime?.fetchedAt).toBeNull();
    expect(badTime?.provenance).toBe('unknown');
  });

  it('treats absent list bodies and wrong station IDs as unavailable evidence', () => {
    expect(normalizeFetchedStationResponse({ ok: true })).toBeNull();
    const wrong = normalizeFetchedStationResponse(fetchedBody({ stationId: 99 }));
    expect(stationMatchesId(wrong as StationEvidence, 42)).toBe(false);
  });
});
