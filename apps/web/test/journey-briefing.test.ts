import { readFile } from 'node:fs/promises';
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
    expect(markup).toContain('<h4 class="briefing-itinerary-heading">Charging itinerary</h4>');
    expect(markup.indexOf('<caption class="briefing-itinerary-caption"')).toBeGreaterThan(-1);
    expect(markup.indexOf('<caption class="briefing-itinerary-caption"')).toBeLessThan(markup.indexOf('<colgroup>'));
    expect(markup).toContain('class="briefing-col-charge-time"');
    expect(markup).toContain('class="briefing-col-cost"');
    expect(markup).not.toContain('gradient');

    const html = buildJourneyBriefingHtml(plan());
    expect(html).toContain('<style>');
    expect(html).toContain('@media print');
    expect(html).toContain('Destination &quot;end&quot;');
    expect(html).toContain('42.7 kWh');
    expect(html).toContain('.briefing-itinerary tbody th .hint{display:block');
    expect(html).not.toContain('gradient');
  });

  it('ties print pagination CSS to real heading/caption markup and a 100% column budget', async () => {
    const markup = renderJourneyBriefingMarkup(plan());
    const html = buildJourneyBriefingHtml(plan());
    const appCss = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
    const widthNames = [
      'stop', 'arrive', 'depart', 'added', 'charge-time', 'cost',
      'arrive-at', 'depart-at', 'tariff',
    ];
    const budget = (css: string) => widthNames.reduce((sum, name) => {
      const match = css.match(new RegExp(`\\.briefing-col-${name}(?![-\\w])[^{}]*\\{[^}]*width:\\s*(\\d+)%`));
      expect(match, `missing print width for ${name}`).not.toBeNull();
      const percent = match ? Number(match[1]) : Number.NaN;
      expect(Number.isFinite(percent)).toBe(true);
      expect(percent).toBeGreaterThan(0);
      return sum + percent;
    }, 0);

    expect(budget(appCss)).toBe(100);
    expect(budget(html)).toBe(100);
    for (const source of [appCss, html]) {
      const compact = source.replace(/\s+/g, '');
      expect(compact).toContain('.briefing-itinerary-heading,.briefing-itinerary-caption,.briefing-itinerary thead{'.replace(/\s+/g, ''));
    }
    expect(markup).toContain('<h4 class="briefing-itinerary-heading">Charging itinerary</h4>');
    expect(markup).toContain('<caption class="briefing-itinerary-caption">Every charging stop with planned energy and known cost</caption>');
    expect(markup.indexOf('<caption class="briefing-itinerary-caption"')).toBeLessThan(markup.indexOf('<colgroup>'));
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
    expect(markup).toContain('Arrival time not stored for this trip');
    expect(markup).not.toContain('Arrive +Unknown');
    expect(markup).not.toContain('No charging stops are needed');
  });

  it('renders sparse saved facts as explicit unknowns without throwing', () => {
    const sparse = {
      origin: { label: 'Old origin' },
      destination: { label: 'Old destination' },
      status: 'degraded',
      source: 'live',
      totals: {},
      stations: [{ stationId: 1, name: 'Old stop' }],
    } as unknown as SavedTrip;

    const data = buildJourneyBriefingData(journeySourceFromSavedTrip(sparse));
    expect(data.stopsAvailable).toBe(true);
    expect(data.itinerary).toHaveLength(1);
    expect(data.itinerary[0]).toMatchObject({
      stationId: 1,
      arriveSocPct: null,
      leaveSocPct: null,
      chargeKwh: null,
      arrivalEtaMin: null,
    });
    const markup = renderJourneyBriefingMarkup(journeySourceFromSavedTrip(sparse));
    expect(markup).toContain('Old stop');
    expect(markup).toContain('Arrival time not stored for this trip');
    expect(markup).not.toContain('No charging stops are needed');
  });

  it('keeps null stop entries as placeholder rows instead of crashing every row', () => {
    const source = plan();
    const validStop = source.stops[0] as TripPlan['stops'][number];
    const broken = plan({
      stops: [null, undefined, validStop] as unknown as TripPlan['stops'],
    });
    const data = buildJourneyBriefingData(broken);
    expect(data.stopsAvailable).toBe(true);
    expect(data.itinerary).toHaveLength(3);
    expect(data.itinerary[0]).toMatchObject({
      stationName: 'Unknown station', stationId: null, chargeKwh: null, arriveSocPct: null,
    });
    expect(data.itinerary[1]).toMatchObject({
      stationName: 'Unknown station', stationId: null, chargeKwh: null, arriveSocPct: null,
    });
    expect(data.itinerary[2]?.stationId).toBe(42);
    const markup = renderJourneyBriefingMarkup(broken);
    const tbody = markup.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0] ?? '';
    expect(tbody.match(/<tr>/g)).toHaveLength(3);
    expect(markup).toContain('1. Unknown station');
    expect(markup).toContain('2. Unknown station');
    expect(markup).not.toContain('No charging stops are needed');
  });

  it('preserves unreadable stop lists as Unknown, never as a no-stop route', () => {
    const fresh = plan({ stops: undefined as unknown as TripPlan['stops'] });
    expect(buildJourneyBriefingData(fresh).stopsAvailable).toBe(false);
    const freshMarkup = renderJourneyBriefingMarkup(fresh);
    expect(freshMarkup).toContain('Charging itinerary unavailable — the plan stop list is missing or malformed.');
    expect(freshMarkup).not.toContain('No charging stops are needed for this trip.');

    const saved = {
      id: 'saved-missing-list', name: 'Missing list', createdAt: '2026-01-01T00:00:00.000Z',
      origin: { label: 'Old origin' }, destination: { label: 42 },
      status: 'ok', source: 'live', routeDistanceKm: 120, routeDurationMin: 120,
      geometry: [], totals: {},
    } as unknown as SavedTrip;
    const source = journeySourceFromSavedTrip(saved);
    expect(source.stops).toBeNull();
    expect(source.destination.label).toBe('Unknown');
    const markup = renderJourneyBriefingMarkup(source);
    expect(markup).toContain('Charging itinerary unavailable — the plan stop list is missing or malformed.');
    expect(markup).not.toContain('No charging stops are needed for this trip.');
    expect(markup).not.toContain('undefined');
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
