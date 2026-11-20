import { describe, expect, it } from 'vitest';
import type { SavedTrip, TripPlan } from '@indeev/core';
import {
  buildJourneyBriefingData,
  buildJourneyBriefingHtml,
  journeySourceFromSavedTrip,
  renderJourneyBriefingMarkup,
} from '../src/journey-briefing.js';

function station(id: number, name: string): TripPlan['stops'][number]['station'] {
  return {
    stationId: id, name, brand: 'statiq', lat: 0, lon: 0,
    address: null, city: null, hours: null, openText: null,
    rating: null, reviewCount: null, reliability: null, fetchedAt: '2026-01-01T00:00:00.000Z',
    amenities: [], stationUrl: null, navUrl: null, chargers: [],
  };
}

function plan(overrides: Partial<TripPlan> = {}): TripPlan {
  const base: TripPlan = {
    id: 'fixture', createdAt: '2026-01-01T00:00:00.000Z',
    origin: { label: 'Origin &<start>', lat: 0, lon: 0 },
    destination: { label: 'Destination "end"', lat: 2, lon: 0 },
    vehicle: { label: 'Harrier', catalogId: null, batteryKwh: 75, claimedRangeKm: 627, realWorldRangeKm: null },
    status: 'degraded', source: 'synthetic', routeDistanceKm: 999,
    routeDurationMin: 240, geometry: [], stationsSeen: 1,
    warnings: ['Known evidence warning'],
    totals: {
      distanceKm: 600, driveTimeMin: 400, chargeTimeMin: 60, totalTimeMin: 460,
      chargeKwh: 50, estPriceInr: 1000, finalSocPct: 12,
    },
    stops: [{
      station: station(42, 'Stop & Co'), chainageKm: 280, legKm: 282, detourKm: 2,
      arriveSocPct: 20, leaveSocPct: 80, chargeKwh: 42.7, pricePerKwh: 20,
      estPriceInr: 854, chargeTimeMin: 42, arrivalEtaMin: 190,
      departureEtaMin: 232,
    }],
  };
  return { ...base, ...overrides };
}

describe('journey briefing', () => {
  it('derives final leg from authoritative totals and chainage, not route metadata', () => {
    const data = buildJourneyBriefingData(plan());
    // totals.distanceKm 600 - stop chainage 280 + detour 2 = 322 km.
    expect(data.legs).toHaveLength(2);
    expect(data.legs[0]).toMatchObject({ distanceKm: 282, distanceBasis: 'stop-leg' });
    expect(data.legs[1]).toMatchObject({ distanceKm: 322, distanceBasis: 'totals-chainage' });
    expect(data.legs[1]?.etaAtArrivalMin).toBe(460);
  });

  it('never invents a starting charge or per-stop evidence', () => {
    const data = buildJourneyBriefingData(plan());
    expect(data.battery[0]).toMatchObject({
      kind: 'start', arriveSocPct: null, departSocPct: null,
    });
    expect(data.battery[0]?.note).toContain('not stored');
    expect(data.itinerary[0]).toMatchObject({
      stationId: 42, chargeKwh: 42.7, chargeTimeMin: 42, estPriceInr: 854,
    });
  });

  it('includes every stop and prominent evidence labels in screen and export markup', () => {
    const markup = renderJourneyBriefingMarkup(plan());
    expect(markup).toContain('Journey briefing');
    expect(markup).toContain('Synthetic data');
    expect(markup).toContain('Degraded coverage');
    expect(markup).toContain('Known evidence warning');
    expect(markup).toContain('Stop &amp; Co');
    expect(markup).toContain('42.7 kWh');
    expect(markup).toContain('42 min');
    expect(markup).toContain('role="meter"');
    expect(markup).toContain('aria-label="Arrive charge at Stop &amp; Co"');
    expect(markup).toContain('role="region"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).not.toContain('gradient');

    const html = buildJourneyBriefingHtml(plan());
    expect(html).toContain('<style>');
    expect(html).toContain('@media print');
    expect(html).toContain('Destination &quot;end&quot;');
    expect(html).toContain('42.7 kWh');
    expect(html).toContain('.briefing-itinerary tbody th .hint{display:block');
    expect(html).not.toContain('gradient');
  });

  it('keeps every declared stop with explicit Unknown cells and no plan mutation', () => {
    const source = plan();
    const incomplete = {
      ...source,
      stops: [{
        ...(source.stops[0] as TripPlan['stops'][number]),
        chargeKwh: Number.NaN,
        arriveSocPct: -3,
        leaveSocPct: 140,
        legKm: -20,
      }],
    };
    const originalWarnings = [...incomplete.warnings];

    const first = buildJourneyBriefingData(incomplete);
    const second = buildJourneyBriefingData(incomplete);

    expect(incomplete.warnings).toEqual(originalWarnings);
    expect(first.warnings).toContain(
      'Journey briefing: some charging facts for stop 1 are unknown or invalid; missing values stay Unknown.',
    );
    expect(second.warnings).toEqual(first.warnings);
    expect(first.itinerary).toHaveLength(1);
    expect(first.itinerary[0]).toMatchObject({
      stationId: 42, chargeKwh: null, arriveSocPct: null, leaveSocPct: null, legKm: null,
    });
    const markup = renderJourneyBriefingMarkup(incomplete);
    expect(markup).toContain('Stop &amp; Co');
    expect(markup).toContain('Station 42');
    expect(markup).not.toContain('No charging stops are needed');
    expect(markup).not.toContain('aria-valuenow="140"');
    expect(markup).not.toContain('aria-valuenow="-3"');
    expect(markup.match(/Unknown/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('bounds totals and preserves fractional tariffs for planned costs only', () => {
    const source = plan();
    const invalid = plan({
      totals: {
        ...(source.totals as TripPlan['totals']),
        chargeKwh: -5,
        finalSocPct: 101,
      },
      stops: [{
        ...(source.stops[0] as TripPlan['stops'][number]),
        pricePerKwh: 22.75,
      }],
    });
    const data = buildJourneyBriefingData(invalid);
    expect(data.chargeKwh).toBeNull();
    expect(data.finalSocPct).toBeNull();
    expect(data.itinerary[0]?.pricePerKwh).toBe(22.75);
    expect(renderJourneyBriefingMarkup(invalid)).toContain('Rs. 22.75/kWh');
    expect(buildJourneyBriefingHtml(invalid)).toContain('Rs. 22.75/kWh');
  });

  it('adapts saved station facts while keeping unstored ETAs unknown', () => {
    const live = plan();
    const saved: SavedTrip = {
      id: 'saved-fixture', name: 'Fixture trip', createdAt: live.createdAt,
      origin: live.origin, destination: live.destination, vehicle: live.vehicle,
      status: live.status, source: live.source,
      routeDistanceKm: live.routeDistanceKm, routeDurationMin: live.routeDurationMin,
      geometry: [[0, 0], [2, 0]],
      stations: [{
        stationId: 42, name: 'Stop & Co', lat: 0, lon: 0,
        chainageKm: 280, legKm: 282, detourKm: 2,
        arriveSocPct: 20, leaveSocPct: 80, chargeKwh: 42.7,
        pricePerKwh: 20, estPriceInr: 854, chargeTimeMin: 42,
      }],
      totals: live.totals,
    };

    const data = buildJourneyBriefingData(journeySourceFromSavedTrip(saved));
    expect(data.stopsAvailable).toBe(true);
    expect(data.legs[0]).toMatchObject({ distanceKm: 282, distanceBasis: 'stop-leg' });
    expect(data.itinerary[0]).toMatchObject({
      stationId: 42, chargeKwh: 42.7, chargeTimeMin: 42,
      arrivalEtaMin: null, departureEtaMin: null,
    });
    const markup = renderJourneyBriefingMarkup(journeySourceFromSavedTrip(saved));
    expect(markup).toContain('42.7 kWh');
    expect(markup).toContain('Station 42');
    expect(markup).not.toContain('No charging stops are needed');
  });

  it('shows unknown costs as unknown and handles no-stop routes', () => {
    const noStops = plan({
      stops: [],
      totals: {
        distanceKm: 120, driveTimeMin: 120, chargeTimeMin: 0, totalTimeMin: 120,
        chargeKwh: 0, estPriceInr: null, finalSocPct: 30,
      },
    });
    const data = buildJourneyBriefingData(noStops);
    expect(data.legs).toMatchObject([{ distanceKm: 120, distanceBasis: 'route-total' }]);
    expect(data.knownCostInr).toBeNull();
    expect(renderJourneyBriefingMarkup(noStops)).toContain('No charging stops are needed');
    expect(renderJourneyBriefingMarkup(noStops)).toContain('Unknown');
  });
});
