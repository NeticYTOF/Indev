/**
 * Saved-trip comparison model and printable markup.
 *
 * Pure and read-only: it consumes the same GET /api/trips records the drawer
 * already holds. No provider, geocoder, planner, AI, station or storage call
 * is involved. Facts the saved record does not hold stay Unknown; a signed
 * difference is emitted only when both sides carry a valid value in the same
 * unit, and never implies a best route.
 */
import { formatDuration } from './format.js';

export type ComparisonMetricKey =
  | 'distanceKm'
  | 'totalTimeMin'
  | 'chargeTimeMin'
  | 'energyKwh'
  | 'costInr'
  | 'finalSocPct'
  | 'stopCount';

export interface ComparisonMetric {
  readonly value: number | null;
  readonly display: string;
}

export interface ComparisonVehicle {
  readonly label: string;
  readonly batteryKwh: number | null;
  readonly batteryDisplay: string;
  readonly claimedRangeKm: number | null;
  readonly claimedDisplay: string;
  readonly realWorldRangeKm: number | null;
  readonly realWorldDisplay: string;
}

export interface ComparisonStop {
  readonly name: string;
  readonly stationId: number | null;
  readonly legKm: ComparisonMetric;
  readonly arriveSocPct: ComparisonMetric;
  readonly leaveSocPct: ComparisonMetric;
  readonly addedKwh: ComparisonMetric;
  readonly tariff: ComparisonMetric;
  readonly chargeTimeMin: ComparisonMetric;
}

export interface ComparisonSide {
  readonly slot: 'A' | 'B';
  readonly name: string;
  readonly originLabel: string;
  readonly destinationLabel: string;
  readonly origin: readonly [number, number] | null;
  readonly destination: readonly [number, number] | null;
  readonly sourceLabel: string;
  readonly synthetic: boolean;
  readonly degraded: boolean;
  readonly vehicle: ComparisonVehicle;
  readonly metrics: Readonly<Record<ComparisonMetricKey, ComparisonMetric>>;
  readonly stopsKnown: boolean;
  readonly stops: readonly ComparisonStop[];
  readonly notes: readonly string[];
}

export interface ComparisonDiff {
  readonly key: ComparisonMetricKey;
  readonly label: string;
  readonly value: number | null;
  readonly display: string;
}

export interface TripComparison {
  readonly sides: readonly [ComparisonSide, ComparisonSide];
  readonly diffs: readonly ComparisonDiff[];
  readonly contextNotes: readonly string[];
  readonly differentEndpoints: boolean;
  readonly differentVehicle: boolean;
}

type RawRecord = Record<string, unknown>;

const METRIC_LABELS: Readonly<Record<ComparisonMetricKey, string>> = {
  distanceKm: 'Route distance',
  totalTimeMin: 'Total time',
  chargeTimeMin: 'Charging time',
  energyKwh: 'Energy added',
  costInr: 'Known cost',
  finalSocPct: 'Destination charge',
  stopCount: 'Charging stops',
};

function record(value: unknown): RawRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as RawRecord
    : null;
}

/** Read only own DATA properties; no inherited value or accessor is trusted. */
function read(value: unknown, key: string): unknown {
  const source = record(value);
  if (!source) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor != null && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown, fallback = 'Unknown'): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function finite(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function coordinate(value: unknown): readonly [number, number] | null {
  const lat = finite(read(value, 'lat'), -90, 90);
  const lon = finite(read(value, 'lon'), -180, 180);
  return lat != null && lon != null ? [lat, lon] : null;
}

function numberText(value: number | null, suffix = ''): string {
  return value == null ? 'Unknown' : `${String(value)}${suffix}`;
}

function durationText(value: number | null): string {
  return value == null ? 'Unknown' : formatDuration(value);
}

function moneyText(value: number | null): string {
  return value == null ? 'Unknown' : `Rs. ${Math.round(value).toLocaleString('en-IN')}`;
}

function tariffText(value: number | null): string {
  return value == null ? 'Unknown' : `Rs. ${String(value)}/kWh`;
}

function metric(value: unknown, render: (n: number | null) => string, min = 0, max = Number.MAX_SAFE_INTEGER): ComparisonMetric {
  const valid = finite(value, min, max);
  return { value: valid, display: render(valid) };
}

function vehicleFrom(raw: RawRecord): ComparisonVehicle {
  const vehicle = record(read(raw, 'vehicle')) ?? {};
  const battery = finite(read(vehicle, 'batteryKwh'));
  const claim = finite(read(vehicle, 'claimedRangeKm'));
  const real = finite(read(vehicle, 'realWorldRangeKm'));
  return {
    label: text(read(vehicle, 'label')),
    batteryKwh: battery,
    batteryDisplay: numberText(battery, ' kWh'),
    claimedRangeKm: claim,
    claimedDisplay: numberText(claim, ' km (mfr)'),
    realWorldRangeKm: real,
    realWorldDisplay: numberText(real, ' km'),
  };
}

function stopFrom(value: unknown): ComparisonStop {
  // SavedStationRef is flat in @indeev/core: name/stationId live on the ref,
  // not under a nested station object.
  const raw = record(value) ?? {};
  const stationId = finite(read(raw, 'stationId'), 1);
  return {
    name: text(read(raw, 'name'), 'Unknown station'),
    stationId: stationId != null && Number.isSafeInteger(stationId) ? stationId : null,
    legKm: metric(read(raw, 'legKm'), (n) => numberText(n, ' km')),
    arriveSocPct: metric(read(raw, 'arriveSocPct'), (n) => numberText(n, '%'), 0, 100),
    leaveSocPct: metric(read(raw, 'leaveSocPct'), (n) => numberText(n, '%'), 0, 100),
    addedKwh: metric(read(raw, 'chargeKwh'), (n) => numberText(n, ' kWh')),
    tariff: metric(read(raw, 'pricePerKwh'), tariffText),
    chargeTimeMin: metric(read(raw, 'chargeTimeMin'), durationText),
  };
}

function sideFrom(trip: unknown, slot: 'A' | 'B'): ComparisonSide {
  const raw = record(trip) ?? {};
  const totals = record(read(raw, 'totals')) ?? {};
  const stopsRaw = read(raw, 'stations');
  const stopsKnown = Array.isArray(stopsRaw);
  const stops = stopsKnown ? (stopsRaw as unknown[]).map(stopFrom) : [];
  const source = read(raw, 'source');
  const notes: string[] = [];
  if (!stopsKnown) notes.push('Stored stop itinerary is Unknown.');
  if (stops.some((stop) => stop.stationId == null || stop.legKm.value == null ||
      stop.addedKwh.value == null || stop.tariff.value == null)) {
    notes.push('Some stored stop facts are Unknown; no charger status is implied.');
  }
  return {
    slot,
    name: text(read(raw, 'name')),
    originLabel: text(read(record(read(raw, 'origin')), 'label')),
    destinationLabel: text(read(record(read(raw, 'destination')), 'label')),
    origin: coordinate(read(raw, 'origin')),
    destination: coordinate(read(raw, 'destination')),
    sourceLabel: source === 'synthetic' ? 'Synthetic (mock)'
      : source === 'live' ? 'Live-sourced plan'
        : 'Provenance Unknown',
    synthetic: source === 'synthetic',
    degraded: read(raw, 'status') === 'degraded',
    vehicle: vehicleFrom(raw),
    metrics: {
      distanceKm: metric(read(raw, 'routeDistanceKm'), (n) => numberText(n, ' km')),
      totalTimeMin: metric(read(totals, 'totalTimeMin'), durationText),
      chargeTimeMin: metric(read(totals, 'chargeTimeMin'), durationText),
      energyKwh: metric(read(totals, 'chargeKwh'), (n) => numberText(n, ' kWh')),
      costInr: metric(read(totals, 'estPriceInr'), moneyText),
      finalSocPct: metric(read(totals, 'finalSocPct'), (n) => numberText(n, '%'), 0, 100),
      stopCount: stopsKnown ? { value: stops.length, display: `${stops.length}` } : { value: null, display: 'Unknown' },
    },
    stopsKnown,
    stops,
    notes,
  };
}

function trimDiff(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function signedDiff(key: ComparisonMetricKey, delta: number): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  const magnitude = Math.abs(delta);
  switch (key) {
    case 'totalTimeMin':
    case 'chargeTimeMin':
      return `${sign}${formatDuration(magnitude)}`;
    case 'distanceKm': return `${sign}${trimDiff(magnitude)} km`;
    case 'energyKwh': return `${sign}${trimDiff(magnitude)} kWh`;
    case 'costInr': return `${sign}Rs. ${trimDiff(magnitude)}`;
    case 'finalSocPct': return `${sign}${trimDiff(magnitude)} pp`;
    case 'stopCount': return `${sign}${magnitude} stop${magnitude === 1 ? '' : 's'}`;
  }
}

function diffFor(key: ComparisonMetricKey, a: ComparisonSide, b: ComparisonSide): ComparisonDiff {
  const left = a.metrics[key].value;
  const right = b.metrics[key].value;
  const value = left != null && right != null ? right - left : null;
  return {
    key,
    label: METRIC_LABELS[key],
    value,
    display: value == null ? 'Not comparable' : signedDiff(key, value),
  };
}

function endpointNotes(a: ComparisonSide, b: ComparisonSide): { notes: string[]; different: boolean } {
  const notes: string[] = [];
  let different = false;
  for (const key of ['originLabel', 'destinationLabel'] as const) {
    if (a[key] !== b[key]) {
      notes.push(`${key === 'originLabel' ? 'Origin' : 'Destination'} labels differ.`);
      different = true;
    }
  }
  for (const key of ['origin', 'destination'] as const) {
    const left = a[key];
    const right = b[key];
    if (left == null || right == null) {
      notes.push(`${key === 'origin' ? 'Origin' : 'Destination'} coordinates are Unknown on at least one trip.`);
    } else if (left[0] !== right[0] || left[1] !== right[1]) {
      notes.push(`${key === 'origin' ? 'Origin' : 'Destination'} coordinates differ.`);
      different = true;
    }
  }
  return { notes, different };
}

function vehicleNotes(a: ComparisonVehicle, b: ComparisonVehicle): { notes: string[]; different: boolean } {
  const notes: string[] = [];
  let different = false;
  if (a.label !== b.label) { notes.push('Vehicle labels differ.'); different = true; }
  for (const key of ['batteryKwh', 'claimedRangeKm', 'realWorldRangeKm'] as const) {
    const left = a[key];
    const right = b[key];
    if (left == null || right == null) {
      notes.push(`${key === 'batteryKwh' ? 'Battery' : key === 'claimedRangeKm' ? 'Claimed range' : 'Real-world range'} is Unknown on at least one trip.`);
    } else if (left !== right) {
      notes.push(`${key === 'batteryKwh' ? 'Battery' : key === 'claimedRangeKm' ? 'Claimed range' : 'Real-world range'} differs.`);
      different = true;
    }
  }
  return { notes, different };
}

export function buildTripComparison(trips: readonly unknown[]): TripComparison {
  if (trips.length !== 2) throw new Error('Exactly two saved trips are required for comparison.');
  const sides: [ComparisonSide, ComparisonSide] = [sideFrom(trips[0], 'A'), sideFrom(trips[1], 'B')];
  const endpoints = endpointNotes(sides[0], sides[1]);
  const vehicles = vehicleNotes(sides[0].vehicle, sides[1].vehicle);
  return {
    sides,
    diffs: (Object.keys(METRIC_LABELS) as ComparisonMetricKey[]).map((key) => diffFor(key, sides[0], sides[1])),
    contextNotes: [...endpoints.notes, ...vehicles.notes],
    differentEndpoints: endpoints.different,
    differentVehicle: vehicles.different,
  };
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] as string);
}

function notesMarkup(notes: readonly string[], className: string): string {
  if (notes.length === 0) return '';
  return `<ul class="${className}">${notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul>`;
}

function stopMarkup(stop: ComparisonStop, index: number): string {
  const id = stop.stationId == null ? '' : `<span class="compare-stop-id">Station ${esc(String(stop.stationId))}</span>`;
  return `<li class="compare-stop"><span class="compare-stop-order">${index + 1}</span>` +
    `<div class="compare-stop-main"><strong>${esc(stop.name)}</strong>${id}` +
    `<span class="compare-stop-facts">Tariff ${esc(stop.tariff.display)} · Added ${esc(stop.addedKwh.display)} · ` +
    `SoC ${esc(stop.arriveSocPct.display)} → ${esc(stop.leaveSocPct.display)} · ` +
    `Leg ${esc(stop.legKm.display)} · Charge ${esc(stop.chargeTimeMin.display)}</span></div></li>`;
}

function sideMarkup(side: ComparisonSide): string {
  const badges = [
    side.synthetic ? '<span class="badge badge-synthetic">Synthetic</span>' : '',
    side.degraded ? '<span class="badge badge-warn">Degraded</span>' : '',
  ].join('');
  const routeBadge = side.synthetic ? '' : `<span class="badge badge-soft">${esc(side.sourceLabel)}</span>`;
  const itinerary = !side.stopsKnown
    ? '<p class="hint">Stored charging stop itinerary is Unknown.</p>'
    : side.stops.length === 0
      ? '<p class="hint">No charging stops stored for this trip.</p>'
      : `<ol class="compare-stops">${side.stops.map(stopMarkup).join('')}</ol>`;
  return `<article class="compare-card" data-compare-card="${side.slot.toLowerCase()}" aria-labelledby="compare-title-${side.slot.toLowerCase()}">` +
    `<header class="compare-card-head"><span class="compare-slot" aria-hidden="true">${side.slot}</span>` +
    `<div><h3 id="compare-title-${side.slot.toLowerCase()}">${esc(side.name)}</h3>` +
    `<p class="compare-endpoints">${esc(side.originLabel)} → ${esc(side.destinationLabel)}</p></div></header>` +
    `<div class="compare-badges">${routeBadge}${badges}</div>` +
    notesMarkup(side.notes, 'compare-notes') +
    `<h4>Vehicle as stored</h4><dl class="compare-facts">` +
    `<div><dt>Vehicle</dt><dd>${esc(side.vehicle.label)}</dd></div>` +
    `<div><dt>Battery</dt><dd>${esc(side.vehicle.batteryDisplay)}</dd></div>` +
    `<div><dt>Claimed range</dt><dd>${esc(side.vehicle.claimedDisplay)}</dd></div>` +
    `<div><dt>Real-world range</dt><dd>${esc(side.vehicle.realWorldDisplay)}</dd></div></dl>` +
    `<h4>Planned totals</h4><dl class="compare-facts">` +
    (Object.keys(METRIC_LABELS) as ComparisonMetricKey[]).map((key) =>
      `<div><dt>${esc(METRIC_LABELS[key])}</dt><dd>${esc(side.metrics[key].display)}</dd></div>`).join('') +
    `</dl><h4>Charging stop itinerary</h4>${itinerary}` +
    `<div class="compare-card-actions">` +
    `<button type="button" class="btn btn-compact btn-ghost" data-compare-open="${side.slot}">Open route ${side.slot}</button>` +
    `<button type="button" class="btn btn-compact btn-ghost" data-compare-edit="${side.slot}">Edit route ${side.slot}</button>` +
    `<button type="button" class="btn btn-compact btn-danger-ghost" data-compare-remove="${side.slot}">Remove ${side.slot}</button>` +
    `</div></article>`;
}

function differenceMarkup(comparison: TripComparison): string {
  const rows = comparison.diffs.map((diff) =>
    `<tr><th scope="row">${esc(diff.label)}</th>` +
    `<td>${esc(comparison.sides[0].metrics[diff.key].display)}</td>` +
    `<td>${esc(comparison.sides[1].metrics[diff.key].display)}</td>` +
    `<td class="compare-delta">${esc(diff.display)}</td></tr>`).join('');
  return `<section class="compare-difference" aria-labelledby="compare-difference-title">` +
    `<h3 id="compare-difference-title">Differences (B − A)</h3>` +
    `<p class="hint">Signed differences are shown only when both trips store a valid value in the same unit. No faster, cheaper or better route is inferred.</p>` +
    `<div class="briefing-scroll" role="region" aria-label="Saved trip differences" tabindex="0">` +
    `<table class="compare-table"><caption>Numeric differences with route B as the baseline subtraction</caption>` +
    `<thead><tr><th scope="col">Measure</th><th scope="col">A</th><th scope="col">B</th><th scope="col">B − A</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div></section>`;
}

export function renderTripComparisonMarkup(comparison: TripComparison): string {
  return `<section class="compare-workspace" data-trip-compare aria-labelledby="compare-workspace-title">` +
    `<div class="compare-toolbar"><div><h2 id="compare-workspace-title">Saved trip comparison</h2>` +
    `<p class="hint">Read-only local comparison of two saved records. Charger status was not fetched and nothing was saved.</p></div>` +
    `<div class="compare-toolbar-actions">` +
    `<button type="button" class="btn btn-ghost" data-compare-back>Back to saved trips</button>` +
    `<button type="button" class="btn btn-ghost" data-compare-swap>Swap A and B</button>` +
    `<button type="button" class="btn btn-ghost" data-compare-clear>Clear selection</button>` +
    `<button type="button" class="btn btn-ghost" data-compare-download>Download comparison</button>` +
    `<button type="button" class="btn btn-ghost" data-compare-print>Print comparison</button>` +
    `</div></div>` +
    `<div class="compare-context"><p class="hint">Stored planned facts from saved trips, not live charger status. Units: km, minutes, kWh, INR and %; B − A uses matching facts only. No automatic best route.</p>` +
    notesMarkup(comparison.contextNotes, 'compare-notes') + `</div>` +
    `<div class="compare-grid">${sideMarkup(comparison.sides[0])}${differenceMarkup(comparison)}${sideMarkup(comparison.sides[1])}</div>` +
    `</section>`;
}

/** Standalone, saveable and printable comparison; flat black/orange only. */
export function buildTripComparisonHtml(comparison: TripComparison): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>IndEV saved trip comparison</title><style>` +
    `*{box-sizing:border-box}body{font-family:Inter,system-ui,sans-serif;background:#050506;color:#F4F2EE;margin:0;padding:24px;overflow-x:hidden}` +
    `.compare-workspace{max-width:1400px;margin:auto}` +
    `.compare-toolbar{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #34322E;padding-bottom:12px}` +
    `.compare-toolbar h2,.compare-card h3,.compare-difference h3{color:#F4F2EE;margin:0 0 6px}` +
    `.compare-toolbar-actions,.compare-card-actions{display:flex;flex-wrap:wrap;gap:8px}button{display:none}` +
    `.hint{color:#B8B4AD;font-size:12px}.compare-badges{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}` +
    `.badge{padding:3px 7px;border:1px solid #F4B951;color:#F4B951;font-size:11px}` +
    `.badge-synthetic{border-color:#E99455;color:#E99455}.badge-soft,.badge-warn{border-color:#34322E;color:#B8B4AD}` +
    `.compare-context{border:1px solid #34322E;padding:10px 12px;margin:14px 0}` +
    `.compare-notes{color:#F4B951;font-size:12px;margin:6px 0 0;padding-left:18px}` +
    `.compare-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}` +
    `.compare-card,.compare-difference{border:1px solid #34322E;background:#0E0E10;padding:14px;min-width:0}` +
    `.compare-card-head{display:flex;gap:10px;align-items:flex-start}.compare-slot{color:#D87932;font-size:24px;font-weight:700}` +
    `.compare-endpoints{color:#B8B4AD;font-size:12px;margin:0;overflow-wrap:anywhere}` +
    `.compare-facts{display:grid;gap:6px;margin:8px 0 16px}.compare-facts div{display:grid;grid-template-columns:minmax(90px,40%) 1fr;gap:8px;border-bottom:1px solid #34322E;padding-bottom:5px}` +
    `.compare-facts dt{color:#B8B4AD;font-size:12px}.compare-facts dd{margin:0;overflow-wrap:anywhere}` +
    `.compare-stops{list-style:none;padding:0;margin:8px 0}.compare-stop{display:flex;gap:8px;padding:8px 0;border-bottom:1px solid #34322E;min-width:0}` +
    `.compare-stop-order{color:#D87932;font-weight:700}.compare-stop-main{display:grid;gap:3px;min-width:0}.compare-stop-facts{color:#B8B4AD;font-size:12px;overflow-wrap:anywhere}` +
    `.compare-table{width:100%;border-collapse:collapse;font-size:12px}.compare-table caption{text-align:left;color:#B8B4AD;padding-bottom:8px}` +
    `.compare-table th,.compare-table td{border:1px solid #34322E;padding:7px;text-align:left;vertical-align:top}.compare-delta{color:#D87932;white-space:nowrap}` +
    `@media (max-width:900px){.compare-grid{grid-template-columns:1fr}}` +
    `@media print{body{background:#fff;color:#111;padding:0}.compare-card,.compare-difference,.compare-context{border-color:#888;background:#fff}.hint,.compare-facts dt,.compare-stop-facts{color:#444}` +
    `.badge,.compare-delta{color:#111;border-color:#888}.compare-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}` +
    `[data-compare-card='a']{grid-area:1/1}[data-compare-card='b']{grid-area:1/2}.compare-difference{grid-area:2/1/3/3}` +
    `.compare-toolbar{display:block!important;border:0;padding:0 0 8px}.compare-toolbar-actions,.compare-toolbar .hint,.compare-card-actions{display:none!important}.compare-toolbar h2{display:block!important;font-size:18pt}` +
    `.compare-card h4,.compare-difference h4,.compare-stop-id,.compare-notes,.compare-toolbar h2{color:#111}` +
    `.compare-toolbar h2,.compare-card h3,.compare-difference h3,.compare-slot,.compare-table caption,.compare-endpoints{color:#111}` +
    `.compare-table{table-layout:fixed;width:100%;font-size:12px}.compare-table th,.compare-table td,.compare-table thead th,.compare-delta{color:#111;background:#fff;white-space:normal;overflow-wrap:anywhere}` +
    `.compare-card h3,.compare-card h4,.compare-difference h3{break-after:avoid;page-break-after:avoid}` +
    `.compare-notes,.compare-stop,.compare-facts div{break-inside:avoid;page-break-inside:avoid}}` +
    `</style></head><body><main>${renderTripComparisonMarkup(comparison)}</main></body></html>`;
}
