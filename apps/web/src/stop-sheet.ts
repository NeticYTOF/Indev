/**
 * Stop details: tap a charging stop (map marker or card) to see everything
 * known about it — distances to the neighbouring stops, the full charger
 * list with every plug, battery in/out, timing and price — in a floating
 * sheet over the map.
 *
 * Rendering is pure (renderStopSheetMarkup / renderChargerList) so it can be
 * unit-tested; the controller only wires DOM, focus and keyboard behaviour.
 * Every value comes from untrusted plan / saved-trip data and is validated
 * and escaped here. Opening never fetches: "Fetch live status" is a separate,
 * explicit, single GET per click.
 */
import { formatDateTime, formatDuration, formatEta, formatInr, formatTariff, lastUsedLabel } from './format.js';
import { formatLegKm, tripLegs, type LegInfo } from './leg-distance.js';
import { safeHttpUrl, stationDirectionsUrl } from './safe-url.js';
import { renderFetchedStationEvidence } from './station-evidence-panel.js';
import {
  normalizeFetchedStationResponse, normalizePlannedStation, plugHealthLabel, safeStationId,
  stationMatchesId, type PlugHealthView, type StationChargerEvidence,
} from './station-evidence.js';

export type StopSheetSource = 'plan' | 'saved';

export interface StopSheetEntry {
  index: number;
  total: number;
  source: StopSheetSource;
  /** Raw PlanStop (fresh plan) or SavedStationRef (saved trip). */
  stop: unknown;
  legIn: LegInfo | null;
  legOut: LegInfo | null;
}

const SAFE_BRANDS = new Set(['statiq', 'tata', 'bpcl', 'hp', 'other']);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function num(value: unknown, min = 0, max = 1e7): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function text(value: unknown, fallback = 'Unknown'): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/** Station view regardless of source (PlanStop.station or the saved ref itself). */
function stationOf(entry: StopSheetEntry): Record<string, unknown> {
  const s = record(entry.stop) ?? {};
  return entry.source === 'plan' ? record(s.station) ?? {} : s;
}

function socBar(label: string, soc: number | null): string {
  const pct = soc == null ? 0 : Math.max(0, Math.min(100, soc));
  const tone = soc == null ? 'unknown' : soc >= 45 ? 'high' : soc >= 20 ? 'mid' : 'low';
  return `<div class="ss-soc ss-soc-${tone}">` +
    `<span class="ss-soc-label">${label}</span>` +
    `<span class="ss-soc-bar" role="img" aria-label="${label} ${soc == null ? 'Unknown' : `${Math.round(soc)}%`}">` +
    `<span class="ss-soc-fill" style="--soc:${pct}%"></span></span>` +
    `<span class="ss-soc-value">${soc == null ? 'Unknown' : `${Math.round(soc)}%`}</span></div>`;
}

const HEALTH_TONE: Record<PlugHealthView, string> = {
  'working-free': 'ok', 'working-occupied': 'busy', finishing: 'ok', faulted: 'bad',
  uncertain: 'warn', offline: 'bad', unknown: 'unknown',
};

/** Compact "2 free · 1 occupied" summary for a charger's plugs. */
export function plugSummary(charger: StationChargerEvidence): string {
  if (charger.connectorsMissing) return 'Plugs Unknown';
  if (charger.connectors.length === 0) return 'No plugs listed';
  const counts = new Map<string, number>();
  for (const c of charger.connectors) {
    const key = c.health === 'working-free' || c.health === 'finishing' ? 'free'
      : c.health === 'working-occupied' ? 'occupied'
        : c.health === 'faulted' ? 'faulted'
          : c.health === 'offline' ? 'offline'
            : c.health === 'uncertain' ? 'uncertain' : 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return ['free', 'occupied', 'uncertain', 'faulted', 'offline', 'unknown']
    .filter((k) => counts.has(k)).map((k) => `${counts.get(k)} ${k}`).join(' · ');
}

/**
 * Charger list rows. `compact` = one line per charger (stop cards);
 * full = every plug with its health (the sheet).
 */
export function renderChargerList(
  station: unknown,
  selectedChargerId: number | null,
  options: { compact?: boolean } = {},
): string {
  const s = record(station);
  if (!s || !Array.isArray(s.chargers)) {
    return '<p class="charger-list-empty">Charger list Unknown</p>';
  }
  const evidence = normalizePlannedStation(station);
  if (evidence.chargers.length === 0) {
    return '<p class="charger-list-empty">No chargers were listed for this station.</p>';
  }
  const rows = evidence.chargers.map((charger, i) => {
    const selected = selectedChargerId != null && charger.chargerId === selectedChargerId;
    const kw = charger.kw == null ? 'kW Unknown' : `${Math.round(charger.kw * 10) / 10} kW`;
    const tariff = charger.pricePerKwh == null ? 'Tariff unknown' : formatTariff(charger.pricePerKwh);
    const plugs = options.compact ? '' : `<ul class="charger-plugs">${charger.connectorsMissing
      ? '<li class="charger-plug tone-unknown">Plug list Unknown</li>'
      : charger.connectors.map((p, j) => {
        const flags = [
          p.contradiction ? '<span class="plug-flag">Contradictory status</span>' : '',
          p.invalidAvailability ? '<span class="plug-flag">Invalid availability</span>' : '',
        ].join('');
        return `<li class="charger-plug tone-${HEALTH_TONE[p.health]}" style="--j:${j}">` +
          `<span class="plug-dot" aria-hidden="true"></span>` +
          `<span class="plug-type">${escapeHtml(p.type ?? 'Type unknown')}</span>` +
          `<span class="plug-health">${escapeHtml(plugHealthLabel(p.health))}</span>${flags}</li>`;
      }).join('')}</ul>`;
    return `<li class="charger-row${selected ? ' is-selected' : ''}" style="--i:${i}" data-charger-id="${charger.chargerId ?? ''}">` +
      `<div class="charger-row-head">` +
      `<span class="charger-name">${escapeHtml(charger.name ?? `Charger ${i + 1}`)}</span>` +
      `<span class="charger-kw">${escapeHtml(kw)}</span></div>` +
      `<div class="charger-row-meta">` +
      `<span>${escapeHtml(charger.type ?? 'Type unknown')}</span>` +
      `<span>${escapeHtml(tariff)}</span>` +
      `<span>${escapeHtml(plugSummary(charger))}</span>` +
      `<span>Last used ${escapeHtml(lastUsedLabel([charger]))}</span>` +
      `${selected ? '<span class="charger-selected-tag">Used for this plan</span>' : ''}` +
      `</div>${plugs}</li>`;
  }).join('');
  return `<ul class="charger-list${options.compact ? ' is-compact' : ''}">${rows}</ul>`;
}

function legLine(leg: LegInfo | null, direction: 'in' | 'out'): string {
  if (!leg) return '';
  const label = direction === 'in' ? `From ${escapeHtml(leg.fromLabel)}` : `To ${escapeHtml(leg.toLabel)}`;
  return `<div class="ss-leg ss-leg-${direction}">` +
    `<span class="ss-leg-km">${escapeHtml(formatLegKm(leg.km))}</span>` +
    `<span class="ss-leg-label">${label}</span></div>`;
}

export function renderStopSheetMarkup(entry: StopSheetEntry): string {
  const stop = record(entry.stop) ?? {};
  const s = stationOf(entry);
  const stationId = safeStationId(s.stationId);
  const name = text(s.name, 'Unknown station');
  const rawBrand = typeof s.brand === 'string' ? s.brand.toLowerCase().trim() : '';
  const brand = SAFE_BRANDS.has(rawBrand) ? rawBrand : 'other';
  const brandLabel = SAFE_BRANDS.has(rawBrand) ? rawBrand.charAt(0).toUpperCase() + rawBrand.slice(1) : 'Unknown';
  const selected = record(stop.selectedCharger);
  const selectedId = num(selected?.chargerId, 1, Number.MAX_SAFE_INTEGER);
  const rating = num(s.rating, 0, 5);
  const reviews = num(s.reviewCount, 0);
  const directions = stationDirectionsUrl(s.lat, s.lon);
  const page = safeHttpUrl(s.stationUrl);
  const amenities = Array.isArray(s.amenities)
    ? (s.amenities as unknown[]).filter((a): a is string => typeof a === 'string' && a.trim().length > 0).slice(0, 12)
    : [];
  const price = num(stop.estPriceInr);
  const chargerSection = entry.source === 'plan'
    ? renderChargerList(s, selectedId)
    : '<p class="charger-list-empty">This saved trip stores planned charging facts, not a charger list. Fetch live status to see chargers.</p>';

  return `<header class="ss-head">` +
    `<div class="ss-kicker"><span class="ss-step">Stop ${entry.index + 1} of ${entry.total}</span>` +
    `${entry.source === 'plan' ? `<span class="stop-brand brand-${brand}">${escapeHtml(brandLabel)}</span>` : ''}` +
    `${s.synthetic === true ? '<span class="chip chip-synthetic">Synthetic</span>' : ''}</div>` +
    `<h2 class="ss-title" id="stop-sheet-title" tabindex="-1">${escapeHtml(name)}</h2>` +
    `<button type="button" class="ss-close" data-ss-close aria-label="Close charger details"><span aria-hidden="true"></span></button>` +
    `</header>` +
    `<div class="ss-scroll">` +
    `<section class="ss-section ss-legs" aria-label="Distances">` +
    legLine(entry.legIn, 'in') +
    `<div class="ss-leg-node" aria-hidden="true"><span>${entry.index + 1}</span></div>` +
    legLine(entry.legOut, 'out') +
    `<p class="ss-detour">Detour ${num(stop.detourKm) == null ? 'Unknown' : `${(num(stop.detourKm) as number).toFixed(1)} km`} each way · ` +
    `${num(stop.chainageKm) == null ? 'route position Unknown' : `${Math.round(num(stop.chainageKm) as number)} km into the trip`}</p>` +
    `</section>` +
    `<section class="ss-section ss-battery" aria-label="Charging plan">` +
    `<div class="ss-soc-row">${socBar('Arrive', num(stop.arriveSocPct, 0, 100))}` +
    `<span class="ss-charge-arrow" aria-hidden="true"></span>${socBar('Leave', num(stop.leaveSocPct, 0, 100))}</div>` +
    `<dl class="ss-facts">` +
    `<div><dt>Energy added</dt><dd>${num(stop.chargeKwh) == null ? 'Unknown' : `${Math.round(num(stop.chargeKwh) as number)} kWh`}</dd></div>` +
    `<div><dt>Charge time</dt><dd>${escapeHtml(formatDuration(num(stop.chargeTimeMin)))}</dd></div>` +
    `<div><dt>Arrive</dt><dd>${escapeHtml(formatEta(num(stop.arrivalEtaMin)))}</dd></div>` +
    `<div><dt>Depart</dt><dd>${escapeHtml(formatEta(num(stop.departureEtaMin)))}</dd></div>` +
    `<div><dt>Tariff</dt><dd>${escapeHtml(num(stop.pricePerKwh) == null ? 'Tariff unknown' : formatTariff(num(stop.pricePerKwh)))}</dd></div>` +
    `<div><dt>Est. cost</dt><dd>${escapeHtml(price == null ? 'Unknown' : formatInr(price))}</dd></div>` +
    `</dl></section>` +
    `<section class="ss-section" aria-labelledby="ss-chargers-title">` +
    `<h3 class="ss-h" id="ss-chargers-title">Chargers</h3>${chargerSection}</section>` +
    (entry.source === 'plan'
      ? `<section class="ss-section ss-station" aria-label="Station">` +
        `<dl class="ss-facts">` +
        `<div><dt>Rating</dt><dd>${rating == null ? 'No rating' : `★ ${Math.round(rating * 10) / 10}${reviews == null ? '' : ` (${Math.round(reviews)})`}`}</dd></div>` +
        `<div><dt>Hours</dt><dd>${escapeHtml(text(s.hours))}${typeof s.openText === 'string' && s.openText.trim() ? ` · ${escapeHtml(s.openText.trim())}` : ''}</dd></div>` +
        `<div class="ss-wide"><dt>Address</dt><dd>${escapeHtml(text(s.address))}${typeof s.city === 'string' && s.city.trim() ? `, ${escapeHtml(s.city.trim())}` : ''}</dd></div>` +
        `<div class="ss-wide"><dt>Snapshot fetched</dt><dd>${escapeHtml(formatDateTime(typeof s.fetchedAt === 'string' ? s.fetchedAt : null))}</dd></div>` +
        `</dl>` +
        (amenities.length ? `<div class="ss-amenities">${amenities.map((a) => `<span class="chip">${escapeHtml(a)}</span>`).join('')}</div>` : '') +
        `<p class="hint">Reliability: unavailable — no verified score is supplied.</p></section>`
      : '') +
    `<section class="ss-section ss-live" aria-label="Live status">` +
    `<div class="ss-live-status" data-ss-live-status role="status" aria-live="polite">Live status not requested. Opening this sheet never fetches.</div>` +
    `<div class="ss-live-result" data-ss-live-result></div></section>` +
    `</div>` +
    `<footer class="ss-actions">` +
    `<div class="ss-nav">` +
    `<button type="button" class="btn btn-compact btn-ghost" data-variant="outline" data-size="sm" data-ss-prev aria-label="Previous stop"${entry.index === 0 ? ' disabled' : ''}>‹</button>` +
    `<button type="button" class="btn btn-compact btn-ghost" data-variant="outline" data-size="sm" data-ss-next aria-label="Next stop"${entry.index >= entry.total - 1 ? ' disabled' : ''}>›</button>` +
    `</div>` +
    `${directions ? `<a class="btn btn-compact" data-variant="secondary" data-size="sm" href="${escapeHtml(directions)}" target="_blank" rel="noreferrer">Directions</a>` : ''}` +
    `${page ? `<a class="btn btn-compact btn-ghost" data-variant="outline" data-size="sm" href="${escapeHtml(page)}" target="_blank" rel="noreferrer">Station page</a>` : ''}` +
    `<button type="button" class="btn btn-compact btn-ghost" data-variant="outline" data-size="sm" data-ss-fetch${stationId == null ? ' disabled aria-label="Fetch live status unavailable — station id Unknown"' : ''}>Fetch live status</button>` +
    `<button type="button" class="btn btn-compact btn-ghost" data-variant="outline" data-size="sm" data-ss-show>Show in list</button>` +
    `</footer>`;
}

export interface StopSheetContext {
  source: StopSheetSource;
  stops: readonly unknown[];
  originLabel: unknown;
  destinationLabel: unknown;
  totalDistanceKm: unknown;
  /** Highlight the stop on the map (null clears). */
  onActive?: (index: number | null) => void;
  /** Pan the map to the stop. */
  onReveal?: (index: number) => void;
  /** The card for this stop in the planner/saved panel. */
  cardFor?: (index: number) => HTMLElement | null;
}

let sheet: HTMLElement | null = null;
let context: StopSheetContext | null = null;
let current = -1;
let returnFocus: HTMLElement | null = null;
let generation = 0;

function ensureSheet(): HTMLElement {
  if (sheet && sheet.isConnected) return sheet;
  sheet = document.createElement('aside');
  sheet.className = 'stop-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'false');
  sheet.setAttribute('aria-labelledby', 'stop-sheet-title');
  sheet.hidden = true;
  sheet.addEventListener('keydown', onKey);
  (document.getElementById('app') ?? document.body).appendChild(sheet);
  return sheet;
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.preventDefault(); closeStopSheet(); return; }
  const target = event.target as HTMLElement | null;
  if (target?.closest('input, textarea, select, a')) return;
  if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
}

function step(delta: number): void {
  if (!context) return;
  const next = current + delta;
  if (next < 0 || next >= context.stops.length) return;
  render(next, delta > 0 ? 'next' : 'prev');
}

function highlightCard(index: number | null, flash = false): void {
  document.querySelectorAll('.stop-card.is-active').forEach((card) => card.classList.remove('is-active'));
  if (index == null || !context?.cardFor) return;
  const card = context.cardFor(index);
  if (!card) return;
  card.classList.add('is-active');
  if (flash) {
    card.classList.remove('is-flash');
    void card.offsetWidth;
    card.classList.add('is-flash');
  }
}

function render(index: number, direction: 'open' | 'next' | 'prev'): void {
  if (!context) return;
  const root = ensureSheet();
  const legs = tripLegs({
    originLabel: context.originLabel, destinationLabel: context.destinationLabel,
    stops: context.stops, totalDistanceKm: context.totalDistanceKm,
  });
  current = index;
  generation += 1;
  root.innerHTML = `<div class="ss-inner" data-dir="${direction}">${renderStopSheetMarkup({
    index, total: context.stops.length, source: context.source, stop: context.stops[index],
    legIn: legs[index] ?? null, legOut: legs[index + 1] ?? null,
  })}</div>`;
  root.dataset.stopIndex = String(index);
  wire(root, index);
  context.onActive?.(index);
  context.onReveal?.(index);
  highlightCard(index);
  root.querySelector<HTMLElement>('#stop-sheet-title')?.focus({ preventScroll: true });
}

function wire(root: HTMLElement, index: number): void {
  root.querySelector('[data-ss-close]')?.addEventListener('click', () => closeStopSheet());
  root.querySelector('[data-ss-prev]')?.addEventListener('click', () => step(-1));
  root.querySelector('[data-ss-next]')?.addEventListener('click', () => step(1));
  root.querySelector('[data-ss-show]')?.addEventListener('click', () => {
    const card = context?.cardFor?.(index);
    if (!card) return;
    card.scrollIntoView({ behavior: document.documentElement.classList.contains('reduce-motion') ? 'auto' : 'smooth', block: 'center' });
    highlightCard(index, true);
  });
  const fetchButton = root.querySelector<HTMLButtonElement>('[data-ss-fetch]');
  const status = root.querySelector<HTMLElement>('[data-ss-live-status]');
  const result = root.querySelector<HTMLElement>('[data-ss-live-result]');
  const stationId = context ? safeStationId(stationOf({
    index, total: context.stops.length, source: context.source, stop: context.stops[index], legIn: null, legOut: null,
  }).stationId) : null;
  if (!fetchButton || !status || !result || stationId == null) return;
  let pending = false;
  fetchButton.addEventListener('click', async () => {
    if (pending) return;
    pending = true;
    const mine = generation;
    fetchButton.disabled = true;
    status.textContent = 'Fetching live station status…';
    result.replaceChildren();
    try {
      const response = await fetch(`/api/stations/${stationId}`);
      if (!response.ok) throw new Error('unavailable');
      const evidence = normalizeFetchedStationResponse(await response.json(), new Date().toISOString());
      if (!evidence || !stationMatchesId(evidence, stationId)) throw new Error('mismatch');
      if (mine !== generation || !result.isConnected) return; // a newer stop is showing
      status.textContent = evidence.fetchedAt == null
        ? 'Response received; snapshot time is not verified.'
        : `Snapshot fetched ${formatDateTime(evidence.fetchedAt)}. Availability is not guaranteed live.`;
      result.innerHTML = renderFetchedStationEvidence(evidence) +
        (evidence.chargers.length ? `<h3 class="ss-h">Live chargers</h3>${renderLiveChargers(evidence.chargers)}` : '');
    } catch {
      if (mine !== generation || !status.isConnected) return;
      status.textContent = 'Live station status unavailable right now. You can try once more.';
    } finally {
      if (mine === generation && fetchButton.isConnected) {
        pending = false;
        fetchButton.disabled = false;
      }
    }
  });
}

function renderLiveChargers(chargers: StationChargerEvidence[]): string {
  return `<ul class="charger-list">${chargers.map((c, i) =>
    `<li class="charger-row" style="--i:${i}"><div class="charger-row-head">` +
    `<span class="charger-name">${escapeHtml(c.name ?? `Charger ${i + 1}`)}</span>` +
    `<span class="charger-kw">${c.kw == null ? 'kW Unknown' : `${Math.round(c.kw * 10) / 10} kW`}</span></div>` +
    `<div class="charger-row-meta"><span>${escapeHtml(c.type ?? 'Type unknown')}</span><span>${escapeHtml(plugSummary(c))}</span></div>` +
    `<ul class="charger-plugs">${c.connectors.map((p, j) =>
      `<li class="charger-plug tone-${HEALTH_TONE[p.health]}" style="--j:${j}"><span class="plug-dot" aria-hidden="true"></span>` +
      `<span class="plug-type">${escapeHtml(p.type ?? 'Type unknown')}</span>` +
      `<span class="plug-health">${escapeHtml(plugHealthLabel(p.health))}</span></li>`).join('')}</ul></li>`).join('')}</ul>`;
}

/** Open the sheet for one stop of a trip. */
export function openStopSheet(ctx: StopSheetContext, index: number, opener?: HTMLElement | null): void {
  if (index < 0 || index >= ctx.stops.length) return;
  const wasOpen = sheet != null && !sheet.hidden;
  if (!wasOpen) {
    const active = document.activeElement;
    returnFocus = opener ?? (active instanceof HTMLElement && active !== document.body ? active : null);
  }
  context = ctx;
  const root = ensureSheet();
  root.hidden = false;
  root.classList.remove('is-leaving');
  document.documentElement.classList.add('stop-sheet-open');
  render(index, wasOpen ? (index > current ? 'next' : 'prev') : 'open');
}

/** Close the sheet (no-op when closed). Focus returns to the opener. */
export function closeStopSheet(options: { restoreFocus?: boolean } = {}): void {
  if (!sheet || sheet.hidden) { context = null; return; }
  const root = sheet;
  const ctx = context;
  generation += 1;
  context = null;
  current = -1;
  ctx?.onActive?.(null);
  document.querySelectorAll('.stop-card.is-active').forEach((card) => card.classList.remove('is-active'));
  document.documentElement.classList.remove('stop-sheet-open');
  const reduce = document.documentElement.classList.contains('reduce-motion') ||
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const finish = (): void => { root.hidden = true; root.classList.remove('is-leaving'); root.replaceChildren(); };
  if (reduce) finish();
  else {
    root.classList.add('is-leaving');
    window.setTimeout(() => { if (root.classList.contains('is-leaving')) finish(); }, 240);
  }
  const target = returnFocus;
  returnFocus = null;
  if (options.restoreFocus !== false && target?.isConnected) target.focus({ preventScroll: true });
}

export function isStopSheetOpen(): boolean {
  return sheet != null && !sheet.hidden && !sheet.classList.contains('is-leaving');
}
