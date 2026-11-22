import { describe, expect, it } from 'vitest';
import { toSavedTrip, type TripPlan } from '@indeev/core';
import { buildJourneyBriefingData, buildJourneyBriefingHtml,
  journeySourceFromSavedTrip, renderJourneyBriefingMarkup } from '../src/journey-briefing.js';
import { groupPlanWarnings, renderWarningGroupsMarkup } from '../src/warning-presentation.js';

const basePlan = (overrides: Record<string, unknown> = {}) => ({
  id: 'plan-1', createdAt: '2026-11-22T10:00:00.000Z',
  origin: { label: 'Origin', lat: 0, lon: 0 },
  destination: { label: 'Destination', lat: 2, lon: 0 },
  vehicle: { label: 'Test car', catalogId: null, batteryKwh: 60,
    claimedRangeKm: null, realWorldRangeKm: 400 },
  startSocPct: 50, status: 'ok', source: 'live',
  routeDistanceKm: 285, routeDurationMin: 300,
  geometry: [{ lat: 0, lon: 0 }, { lat: 2, lon: 0 }],
  stops: [{ station: { stationId: 42, name: 'Stop', lat: 1, lon: 0 },
    chainageKm: 100, legKm: 100, detourKm: 0, arriveSocPct: 30, leaveSocPct: 80,
    chargeKwh: 30, pricePerKwh: 20, estPriceInr: 600, chargeTimeMin: 30,
    arrivalEtaMin: 120, departureEtaMin: 150 }],
  totals: { distanceKm: 285, driveTimeMin: 270, chargeTimeMin: 30,
    totalTimeMin: 300, chargeKwh: 30, estPriceInr: 600, finalSocPct: 20 },
  stationsSeen: 1, warnings: [], ...overrides,
}) as unknown as TripPlan;

const between = (markup: string, from: string, to: string) =>
  markup.slice(markup.indexOf(from), markup.indexOf(to));

describe('functional recorded fields and warning presentation', () => {
  it('renders origin departure and destination arrival only', () => {
    const data = buildJourneyBriefingData(basePlan());
    expect(data.battery[0]).toMatchObject({ kind: 'start', arriveSocPct: null, departSocPct: 50 });
    expect(data.battery.at(-1)).toMatchObject({ kind: 'destination', arriveSocPct: 20,
      departSocPct: null });
    const markup = renderJourneyBriefingMarkup(basePlan());
    const start = between(markup, 'data-kind="start"', 'data-kind="stop"');
    expect(start).toContain('Depart');
    expect(start).not.toContain('>Arrive<');
    const destinationStart = markup.lastIndexOf('data-kind="destination"');
    const destination = markup.slice(destinationStart,
      markup.indexOf('</li>', destinationStart));
    expect(destination).toContain('Arrive');
    expect(destination).not.toContain('>Depart<');
  });

  it('accepts zero start but never invents missing or invalid starts', () => {
    const zero = buildJourneyBriefingData(basePlan({ startSocPct: 0 }));
    expect(zero.battery[0]?.departSocPct).toBe(0);
    for (const value of [undefined, '50', null, 101, -1, Number.NaN]) {
      const data = buildJourneyBriefingData(basePlan({ startSocPct: value }));
      expect(data.battery[0]?.departSocPct).toBeNull();
      expect(data.battery[0]?.note).toBe('Starting charge not recorded.');
    }
  });

  it('preserves recorded start SOC and planned ETAs through save and export', () => {
    const saved = toSavedTrip(basePlan());
    expect(saved.startSocPct).toBe(50);
    expect(saved.stations[0]).toMatchObject({ arrivalEtaMin: 120, departureEtaMin: 150 });
    const source = journeySourceFromSavedTrip(saved);
    const data = buildJourneyBriefingData(source);
    expect(data.startSocPct).toBe(50);
    expect(data.itinerary[0]).toMatchObject({ arrivalEtaMin: 120, departureEtaMin: 150,
      chargeTimeMin: 30, estPriceInr: 600, pricePerKwh: 20 });
    expect(buildJourneyBriefingHtml(source)).toContain('data-kind="start"');
  });

  it('keeps legacy missing start and ETA values explicitly unknown', () => {
    const saved = toSavedTrip(basePlan({ startSocPct: undefined }));
    const station = saved.stations[0]! as unknown as Record<string, unknown>;
    delete station.arrivalEtaMin;
    delete station.departureEtaMin;
    const data = buildJourneyBriefingData(journeySourceFromSavedTrip(saved));
    expect(data.startSocPct).toBeNull();
    expect(data.battery[0]?.note).toBe('Starting charge not recorded.');
    expect(data.itinerary[0]?.arrivalEtaMin).toBeNull();
    expect(data.itinerary[0]?.departureEtaMin).toBeNull();
  });

  it('dedupes exact actionable warnings and shows candidate counts while closed', () => {
    const warnings: unknown[] = ['Route <b>bad</b>', 'Route <b>bad</b>',
      'Station was not certified.', 'Station was not certified.',
      'Distinct selected stop issue', 7, ''];
    const snapshot = [...warnings];
    const groups = groupPlanWarnings(warnings);
    expect(groups.candidates).toEqual([
      { kind: 'candidate', text: 'Station was not certified.', count: 2 },
    ]);
    expect(groups.selected.map((entry) => entry.text))
      .toEqual(['Route <b>bad</b>', 'Distinct selected stop issue']);
    expect(groups.selected[0]?.count).toBe(2);
    expect(groups.malformed[0]?.count).toBe(2);
    const markup = renderWarningGroupsMarkup(warnings);
    expect(markup).toContain('2 candidate-check notices');
    expect(markup).toContain('data-warning-group="malformed"');
    expect(markup.match(/Route &lt;b&gt;bad&lt;\/b&gt;/g) ?? []).toHaveLength(1);
    expect(markup).toContain('Route notes and warnings');
    expect(markup).not.toContain('certified..');
    expect(warnings).toEqual(snapshot);
  });

  it('does not repeat parent warnings inside embedded briefings', () => {
    const plan = basePlan({ status: 'degraded', source: 'synthetic',
      warnings: ['Chosen stop problem', 'Chosen stop problem'] });
    const snapshot = [...(plan.warnings as unknown[])];
    const embedded = renderJourneyBriefingMarkup(plan, { includePlanWarnings: false });
    expect(embedded).toContain('Degraded coverage');
    expect(embedded).toContain('Synthetic data');
    expect(embedded).not.toContain('Chosen stop problem');
    const standalone = buildJourneyBriefingHtml(plan);
    expect(standalone).toContain('Chosen stop problem');
    expect(standalone).toContain('Repeated 2 times');
    expect(plan.warnings).toEqual(snapshot);
  });
});
