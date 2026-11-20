/**
 * Journey briefing: a whole-trip, print-ready view derived ONLY from facts
 * already present on a live TripPlan or saved trip. No provider calls,
 * persistence, clock, or simulator values are introduced here.
 */
import type { SavedTrip, TripPlan } from '@indeev/core';
import { formatDuration, formatInr, formatKwh, formatTariff } from './format.js';

export interface JourneyBriefingStopSource {
  station: { stationId: number; name: string };
  chainageKm: number;
  legKm: number;
  detourKm: number;
  arriveSocPct: number;
  leaveSocPct: number;
  chargeKwh: number;
  pricePerKwh: number | null;
  estPriceInr: number | null;
  chargeTimeMin: number;
  /** Not stored on a saved trip; the briefing renders it as unknown. */
  arrivalEtaMin?: number;
  departureEtaMin?: number;
}

export interface JourneyBriefingSource {
  origin: { label: string };
  destination: { label: string };
  status: TripPlan['status'];
  source: TripPlan['source'];
  totals: TripPlan['totals'];
  stops: readonly JourneyBriefingStopSource[];
  warnings?: readonly string[];
}

/**
 * Saved trips keep the planned charging facts but not per-stop ETAs. Adapt
 * only that schema boundary; unknown times stay unknown in the briefing.
 */
export function journeySourceFromSavedTrip(trip: SavedTrip): JourneyBriefingSource {
  return {
    origin: trip.origin,
    destination: trip.destination,
    status: trip.status,
    source: trip.source,
    totals: trip.totals,
    stops: trip.stations.map((station) => ({
      station: { stationId: station.stationId, name: station.name },
      chainageKm: station.chainageKm,
      legKm: station.legKm,
      detourKm: station.detourKm,
      arriveSocPct: station.arriveSocPct,
      leaveSocPct: station.leaveSocPct,
      chargeKwh: station.chargeKwh,
      pricePerKwh: station.pricePerKwh,
      estPriceInr: station.estPriceInr,
      chargeTimeMin: station.chargeTimeMin,
    })),
  };
}

export type JourneyLegKind = 'origin' | 'between' | 'final';

export interface JourneyLeg {
  kind: JourneyLegKind;
  fromLabel: string;
  toLabel: string;
  /** Authoritative per-stop leg distance, or a documented chainage/totals derivation. */
  distanceKm: number | null;
  distanceBasis: 'stop-leg' | 'totals-chainage' | 'route-total' | 'unavailable';
  /** Minutes from trip start to arrival; no wall-clock departure is invented. */
  etaAtArrivalMin: number | null;
}

export interface JourneyBatteryPoint {
  kind: 'start' | 'stop' | 'destination';
  label: string;
  arriveSocPct: number | null;
  departSocPct: number | null;
  note: string;
}

export interface JourneyItineraryRow {
  index: number;
  stationName: string;
  stationId: number | null;
  legKm: number | null;
  detourKm: number | null;
  arriveSocPct: number | null;
  leaveSocPct: number | null;
  chargeKwh: number | null;
  chargeTimeMin: number | null;
  pricePerKwh: number | null;
  estPriceInr: number | null;
  arrivalEtaMin: number | null;
  departureEtaMin: number | null;
}

export interface JourneyBriefingData {
  legs: JourneyLeg[];
  battery: JourneyBatteryPoint[];
  itinerary: JourneyItineraryRow[];
  stopsAvailable: boolean;
  routeDistanceKm: number | null;
  totalTimeMin: number | null;
  chargeTimeMin: number | null;
  chargeKwh: number | null;
  knownCostInr: number | null;
  finalSocPct: number | null;
  status: TripPlan['status'];
  source: TripPlan['source'];
  warnings: readonly string[];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonnegative(value: unknown): number | null {
  const number = finiteNumber(value);
  return number != null && number >= 0 ? number : null;
}

function socValue(value: unknown): number | null {
  const number = finiteNumber(value);
  return number != null && number >= 0 && number <= 100 ? number : null;
}

function stationIdValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function legDistance(totalKm: number | null, stop: JourneyBriefingStopSource | undefined): {
  km: number | null;
  basis: JourneyLeg['distanceBasis'];
} {
  if (!stop) {
    return { km: totalKm, basis: totalKm != null ? 'route-total' : 'unavailable' };
  }
  const chainage = nonnegative(stop.chainageKm);
  const detour = nonnegative(stop.detourKm);
  if (totalKm == null || chainage == null || detour == null) return { km: null, basis: 'unavailable' };
  return { km: Math.max(0, totalKm - chainage + detour), basis: 'totals-chainage' };
}

/**
 * `totals.distanceKm` is the same chainage total used by the planner's final
 * reachability math. `routeDistanceKm` is provider metadata and is not mixed
 * into the derived final leg. Per-stop `legKm` values are already authoritative.
 */
export function buildJourneyBriefingData(plan: JourneyBriefingSource): JourneyBriefingData {
  const stopsAvailable = Array.isArray(plan.stops);
  const stops = stopsAvailable ? plan.stops : [];
  // Evidence holes are local to this presentation; never mutate the plan's own warnings.
  const warnings: string[] = Array.isArray(plan.warnings) ? [...plan.warnings] : [];
  if (!stopsAvailable) {
    warnings.push('Journey briefing cannot read the charging stop list from this plan.');
  }

  const routeDistanceKm = nonnegative(plan.totals?.distanceKm);
  const totalTimeMin = nonnegative(plan.totals?.totalTimeMin);
  const chargeTimeMin = nonnegative(plan.totals?.chargeTimeMin);
  const chargeKwh = nonnegative(plan.totals?.chargeKwh);
  const knownCostInr = nonnegative(plan.totals?.estPriceInr);
  const finalSocPct = socValue(plan.totals?.finalSocPct);

  const legs: JourneyLeg[] = [];
  let fromLabel = plan.origin.label;
  stops.forEach((stop, index) => {
    const legKm = nonnegative(stop.legKm);
    legs.push({
      kind: index === 0 ? 'origin' : 'between',
      fromLabel,
      toLabel: stop.station.name,
      distanceKm: legKm,
      distanceBasis: legKm != null ? 'stop-leg' : 'unavailable',
      etaAtArrivalMin: nonnegative(stop.arrivalEtaMin),
    });
    fromLabel = stop.station.name;
  });

  const final = legDistance(routeDistanceKm, stops.at(-1));
  legs.push({
    kind: 'final',
    fromLabel,
    toLabel: plan.destination.label,
    distanceKm: final.km,
    distanceBasis: final.basis,
    etaAtArrivalMin: totalTimeMin,
  });

  const battery: JourneyBatteryPoint[] = [{
    kind: 'start',
    label: plan.origin.label,
    arriveSocPct: null,
    departSocPct: null,
    note: 'Starting charge is not stored in the plan.',
  }];
  stops.forEach((stop) => {
    battery.push({
      kind: 'stop',
      label: stop.station.name,
      arriveSocPct: socValue(stop.arriveSocPct),
      departSocPct: socValue(stop.leaveSocPct),
      note: 'Planned arrival and departure charge at this charging stop.',
    });
  });
  battery.push({
    kind: 'destination',
    label: plan.destination.label,
    arriveSocPct: finalSocPct,
    departSocPct: null,
    note: 'Planned destination arrival charge from plan totals.',
  });

  const itinerary: JourneyItineraryRow[] = [];
  stops.forEach((stop, index) => {
    const legKm = nonnegative(stop.legKm);
    const detourKm = nonnegative(stop.detourKm);
    const arriveSocPct = socValue(stop.arriveSocPct);
    const leaveSocPct = socValue(stop.leaveSocPct);
    const chargeKwh = nonnegative(stop.chargeKwh);
    const chargeTimeMin = nonnegative(stop.chargeTimeMin);
    const arrivalEtaMin = nonnegative(stop.arrivalEtaMin);
    const departureEtaMin = nonnegative(stop.departureEtaMin);
    const required = [
      nonnegative(stop.chainageKm), legKm, detourKm, arriveSocPct,
      leaveSocPct, chargeKwh, chargeTimeMin, arrivalEtaMin, departureEtaMin,
    ];
    if (required.some((value) => value == null)) {
      warnings.push(
        `Journey briefing: some charging facts for stop ${index + 1} are unknown or invalid; missing values stay Unknown.`,
      );
    }
    // Keep every declared stop; an incomplete fact becomes an explicit Unknown cell,
    // never a zero, an invented value, or a silently removed row.
    itinerary.push({
      index: index + 1,
      stationName: stop.station.name,
      stationId: stationIdValue(stop.station.stationId),
      legKm,
      detourKm,
      arriveSocPct,
      leaveSocPct,
      chargeKwh,
      chargeTimeMin,
      pricePerKwh: nonnegative(stop.pricePerKwh),
      estPriceInr: nonnegative(stop.estPriceInr),
      arrivalEtaMin,
      departureEtaMin,
    });
  });

  return {
    stopsAvailable,
    legs,
    battery,
    itinerary,
    routeDistanceKm,
    totalTimeMin,
    chargeTimeMin,
    chargeKwh,
    knownCostInr,
    finalSocPct,
    status: plan.status,
    source: plan.source,
    warnings,
  };
}

function html(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] as string);
}

function minutes(value: number | null): string {
  return value == null ? 'Unknown' : formatDuration(value);
}

function kilometres(value: number | null): string {
  return value == null ? 'Unknown' : `${Math.round(value)} km`;
}

function arrivalOffset(value: number | null): string {
  return value == null
    ? 'Arrival time not stored for this trip'
    : `Arrive +${formatDuration(value)} from departure`;
}

function soc(value: number | null): string {
  return value == null ? 'Unknown' : `${Math.round(value)}%`;
}

function batteryMeter(point: JourneyBatteryPoint): string {
  const bars = [
    { label: 'Arrive', value: point.arriveSocPct },
    { label: 'Depart', value: point.departSocPct },
  ];
  return bars.map(({ label, value }) => {
    const meter = value == null
      ? `<span class="briefing-meter empty" aria-label="${html(label)} charge at ${html(point.label)} not stored"></span>`
      : `<span class="briefing-meter" role="meter" aria-label="${html(label)} charge at ${html(point.label)}" ` +
        `aria-valuemin="0" aria-valuemax="100" ` +
        `aria-valuenow="${Math.round(value)}" aria-valuetext="${label} ${Math.round(value)} percent">` +
        `<span class="briefing-meter-fill" style="width:${Math.max(0, Math.min(100, value))}%"></span></span>`;
    return `<div class="briefing-battery-value"><span class="briefing-battery-label">${label}</span>` +
      `${meter}<strong>${soc(value)}</strong></div>`;
  }).join('');
}

function statusBanners(data: JourneyBriefingData): string {
  const banners: string[] = [];
  if (data.source === 'synthetic') {
    banners.push('<div class="banner banner-synthetic">Synthetic data — mock plan, not live charger evidence.</div>');
  }
  if (data.status === 'degraded') {
    banners.push('<div class="banner banner-warn">Degraded coverage — station or route evidence is incomplete.</div>');
  }
  for (const warning of data.warnings) {
    banners.push(`<div class="banner banner-warn">${html(warning)}</div>`);
  }
  return banners.length > 0 ? `<div class="banners briefing-banners">${banners.join('')}</div>` : '';
}

/** DOM-ready markup; the same function is used by the standalone HTML export. */
export function renderJourneyBriefingMarkup(plan: JourneyBriefingSource): string {
  const data = buildJourneyBriefingData(plan);
  const legItems = data.legs.map((leg) => {
    const basis = leg.distanceBasis === 'totals-chainage'
      ? 'Derived from planned route chainage and detour'
      : leg.distanceBasis === 'stop-leg'
        ? 'Includes detour in both directions'
        : leg.distanceBasis === 'route-total' ? 'Whole route total' : 'Not available from plan facts';
    return `<li class="journey-leg" data-leg-kind="${leg.kind}">` +
      `<span class="journey-leg-place">${html(leg.fromLabel)} <span aria-hidden="true">→</span> ${html(leg.toLabel)}</span>` +
      `<span class="journey-leg-distance">${kilometres(leg.distanceKm)}</span>` +
      `<span class="journey-leg-eta">${arrivalOffset(leg.etaAtArrivalMin)}</span>` +
      `<span class="hint">${basis}</span></li>`;
  }).join('');

  const batteryItems = data.battery.map((point) => `<li class="journey-battery-point" data-kind="${point.kind}">` +
    `<h4>${html(point.label)}</h4>${batteryMeter(point)}<p class="hint">${html(point.note)}</p></li>`).join('');

  const rows = data.itinerary.map((row) => `<tr>` +
    `<th scope="row">${row.index}. ${html(row.stationName)}` +
    `${row.stationId != null ? `<span class="hint">Station ${row.stationId}</span>` : ''}</th>` +
    `<td>${soc(row.arriveSocPct)}</td><td>${soc(row.leaveSocPct)}</td>` +
    `<td>${row.chargeKwh == null ? 'Unknown' : formatKwh(row.chargeKwh)}</td>` +
    `<td>${minutes(row.chargeTimeMin)}</td>` +
    `<td>${row.estPriceInr == null ? 'Unknown' : formatInr(row.estPriceInr)}</td>` +
    `<td>${minutes(row.arrivalEtaMin)}</td><td>${minutes(row.departureEtaMin)}</td>` +
    `<td>${row.pricePerKwh == null ? 'Unknown' : formatTariff(row.pricePerKwh)}</td>` +
    `</tr>`).join('');
  const emptyItinerary = data.stopsAvailable
    ? '<tr><td colspan="9">No charging stops are needed for this trip.</td></tr>'
    : '<tr><td colspan="9">Charging itinerary unavailable — the plan stop list is missing or malformed.</td></tr>';

  const summary = [
    ['Route distance', kilometres(data.routeDistanceKm)],
    ['Total time', minutes(data.totalTimeMin)],
    ['Charging time', minutes(data.chargeTimeMin)],
    ['Energy added', data.chargeKwh == null ? 'Unknown' : formatKwh(data.chargeKwh)],
    ['Known cost', data.knownCostInr == null ? 'Unknown' : formatInr(data.knownCostInr)],
    ['Destination charge', soc(data.finalSocPct)],
  ].map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('');

  return `<section class="journey-briefing" aria-labelledby="journey-briefing-title" data-journey-briefing>` +
    statusBanners(data) +
    `<h3 id="journey-briefing-title">Journey briefing</h3>` +
    `<p class="hint">Times are relative to departure. No wall-clock departure or physical charger availability is assumed.</p>` +
    `<dl class="briefing-summary">${summary}</dl>` +
    `<h4>Whole-trip legs</h4><ol class="journey-legs">${legItems}</ol>` +
    `<h4>Battery profile</h4><ol class="journey-battery-profile">${batteryItems}</ol>` +
    `<h4>Charging itinerary</h4>` +
    `<div class="briefing-scroll" role="region" aria-label="Charging itinerary table" tabindex="0">` +
    `<table class="briefing-itinerary"><caption>Every charging stop with planned energy and known cost</caption>` +
    `<thead><tr><th scope="col">Stop</th><th scope="col">Arrive</th><th scope="col">Depart</th>` +
    `<th scope="col">Added</th><th scope="col">Charge time</th><th scope="col">Cost</th>` +
    `<th scope="col">Arrive at</th><th scope="col">Depart at</th><th scope="col">Tariff</th></tr></thead>` +
    `<tbody>${rows || emptyItinerary}</tbody></table></div>` +
    `</section>`;
}

/** Standalone printable/saveable itinerary; CSS is flat, local, and gradient-free. */
export function buildJourneyBriefingHtml(plan: JourneyBriefingSource): string {
  const title = `${plan.origin.label} to ${plan.destination.label}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>IndEV journey briefing — ${html(title)}</title><style>` +
    `body{font-family:Inter,system-ui,sans-serif;background:#050506;color:#F4F2EE;margin:0;padding:24px}` +
    `.journey-briefing{max-width:960px;margin:auto;background:#0E0E10;border:1px solid #34322E;padding:24px}` +
    `.banner{padding:10px 12px;border:1px solid #F4B951;color:#F4B951;margin-bottom:10px}` +
    `.banner-synthetic{border-color:#E99455;color:#E99455}` +
    `h3,h4{color:#F4F2EE}.hint{color:#B8B4AD;font-size:12px}` +
    `.briefing-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}` +
    `.briefing-summary div{border:1px solid #34322E;padding:10px}.briefing-summary dt{color:#B8B4AD;font-size:12px}` +
    `.briefing-summary dd{margin:4px 0 0;font-weight:700}` +
    `.journey-legs,.journey-battery-profile{list-style:none;padding:0;display:grid;gap:8px}` +
    `.journey-leg,.journey-battery-point{border-bottom:1px solid #34322E;padding:10px 0;min-width:0;overflow-wrap:anywhere}` +
    `.journey-leg{display:grid;gap:4px}.journey-leg-place{font-weight:700}.journey-leg-distance,.journey-leg-eta{color:#F4B951}` +
    `.briefing-battery-value{display:grid;grid-template-columns:54px minmax(40px,1fr) 56px;gap:8px;align-items:center;margin-top:6px}` +
    `.briefing-meter{display:block;height:10px;background:#151517;border:1px solid #34322E}` +
    `.briefing-meter.empty{opacity:.4}.briefing-meter-fill{display:block;height:100%;background:#D87932}` +
    `.briefing-scroll{overflow:auto}.briefing-itinerary{width:100%;border-collapse:collapse;font-size:13px}` +
    `.briefing-itinerary caption{text-align:left;padding:8px 0;color:#B8B4AD}` +
    `.briefing-itinerary th,.briefing-itinerary td{border:1px solid #34322E;padding:8px;text-align:left;vertical-align:top;overflow-wrap:anywhere}` +
    `.briefing-itinerary tbody th .hint{display:block;margin-top:3px;color:#B8B4AD;font-size:11px;font-weight:400}` +
    `.briefing-itinerary thead th{color:#F4B951}button{display:none}` +
    `@media print{body{background:#fff;color:#111;padding:0}.journey-briefing{border:0;background:#fff;color:#111;padding:0}` +
    `h3,h4,.briefing-summary dd{color:#111}.hint,.briefing-summary dt,.briefing-itinerary caption{color:#444}` +
    `.banner{color:#111;border-color:#111}.briefing-meter{background:#eee;border-color:#888}` +
    `.journey-battery-profile{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}` +
    `.briefing-battery-value strong{white-space:normal;overflow-wrap:anywhere}` +
    `.briefing-meter-fill{background:#111}.briefing-itinerary th,.briefing-itinerary td{border-color:#888}` +
    `.briefing-itinerary thead th{color:#111}}` +
    `</style></head><body><main>${renderJourneyBriefingMarkup(plan)}</main></body></html>`;
}

export function downloadJourneyBriefing(plan: JourneyBriefingSource): void {
  const htmlDocument = buildJourneyBriefingHtml(plan);
  const blob = new Blob([htmlDocument], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  const name = `${plan.origin.label}-${plan.destination.label}`
    .replace(/[^\w-]+/g, '-').replace(/-+/g, '-');
  anchor.download = `indeev-journey-${name.slice(0, 60).toLowerCase()}.html`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
