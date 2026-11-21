/**
 * Plan results: honest banners (degraded / synthetic / warnings), hero
 * trip strip, and the charging-stop timeline: numbered rail nodes, per-stop
 * battery in/out with charge between, tariff price, times, rating/reviews,
 * last-used, reliability (unavailable), uncertainty chips, fetched-at
 * freshness, Google Maps directions link.
 */
import * as maplibregl from 'maplibre-gl';
import type { TripPlan } from '@indeev/core';
import { el, escapeHtml } from './planner.js';
import { api } from './api.js';
import { downloadAnimatedExport } from './export.js';
import { downloadJourneyBriefing, renderJourneyBriefingMarkup } from './journey-briefing.js';
import { renderStationEvidencePanel, wireStationEvidence } from './station-evidence-panel.js';
import { safeStationId } from './station-evidence.js';
import { connectorSlug } from '@indeev/core/plug-classifier';
import { toast } from './toast.js';
import { storageWarningText, storageWarningElement } from './storage-warning.js';
import { formatReviewCount, formatDuration, formatEta, formatInr, lastUsedLabel, formatDateTime, formatTariff } from './format.js';
import { safeHttpUrl, stationDirectionsUrl, routeDirectionsLinks } from './safe-url.js';

export function renderPlanPanel(
  panel: HTMLElement,
  map: maplibregl.Map,
  plan: TripPlan,
): void {
  // The compose card stays on top; results render into a section below it.
  let results = panel.querySelector<HTMLElement>('.plan-results');
  if (!results) {
    results = el('<section class="plan-results" aria-label="Trip plan"></section>') as HTMLElement;
    panel.appendChild(results);
  }
  results.innerHTML = '';
  void map;
  const raw = record(plan) ?? {};
  const rawWarnings = raw.warnings;
  const warnings = Array.isArray(rawWarnings) ? rawWarnings : [];
  const warningsUnavailable = rawWarnings != null && !Array.isArray(rawWarnings);
  const totals = record(raw.totals) ?? {};
  // A missing list is NOT an empty route: it is an incomplete plan.
  const stopsKnown = Array.isArray(raw.stops);
  const stops: readonly unknown[] = stopsKnown ? raw.stops as unknown[] : [];
  const stopCount = stopsKnown ? String(stops.length) : 'Unknown';
  const stopCountLabel = stopsKnown ? `Charging stop${stops.length === 1 ? '' : 's'}` : 'Charging stops';
  const originLabel = safeDisplay(record(raw.origin)?.label);
  const destinationLabel = safeDisplay(record(raw.destination)?.label);
  const vehicle = record(raw.vehicle);
  const vehicleLabel = safeDisplay(vehicle?.label);

  // ---- banners ----
  const banners = el('<div class="banners"></div>');
  if (raw.source === 'synthetic') {
    banners.appendChild(el('<div class="banner banner-synthetic">Synthetic data — this plan comes from mock mode, not live chargers.</div>'));
  }
  if (raw.status === 'degraded') {
    banners.appendChild(el('<div class="banner banner-warn">Coverage incomplete: some route samples or station evidence could not be verified. Treat charger coverage as partial.</div>'));
  }
  if (warningsUnavailable) {
    banners.appendChild(el('<div class="banner banner-warn">Plan warnings are unavailable.</div>'));
  }
  if (!stopsKnown) {
    banners.appendChild(el('<div class="banner banner-warn">Charging stop list is Unknown — the itinerary is incomplete; no zero-stop conclusion is implied.</div>'));
  }
  for (const w of warnings) {
    const text = typeof w === 'string' && w.trim().length > 0 ? escapeHtml(w) : 'Warning detail unavailable';
    banners.appendChild(el(`<div class="banner banner-warn">${text}</div>`));
  }
  if (banners.childElementCount > 0) results.appendChild(banners);

  // ---- header ----
  const head = el(`
    <div class="plan-head">
      <div class="plan-route">
        <span class="origin">${originLabel}</span>
        <span class="arrow">→</span>
        <span class="destination">${destinationLabel}</span>
      </div>
      <div class="plan-vehicle">${vehicleLabel}${safeNumber(vehicle?.realWorldRangeKm) != null ? ` · your real-world range ${safeIntegerText(vehicle?.realWorldRangeKm)} km` : ''}${safeNumber(vehicle?.claimedRangeKm) != null ? ` · claim ${safeIntegerText(vehicle?.claimedRangeKm)} km (mfr)` : ''}</div>
    </div>
  `);
  results.appendChild(head);

  // ---- hero trip strip ----
  const strip = el(`
    <div class="trip-strip">
      <div class="strip-cell"><span class="strip-num">${escapeHtml(formatDuration(safeNumber(totals.totalTimeMin)))}</span><span class="strip-label">Total time</span></div>
      <div class="strip-cell"><span class="strip-num">${safeIntegerText(raw.routeDistanceKm)}<span class="unit">km</span></span><span class="strip-label">Distance</span></div>
      <div class="strip-cell"><span class="strip-num">${escapeHtml(stopCount)}</span><span class="strip-label">${escapeHtml(stopCountLabel)}</span></div>
      <div class="strip-cell"><span class="strip-num">${escapeHtml(formatDuration(safeNumber(totals.chargeTimeMin)))}</span><span class="strip-label">Charging time</span></div>
      <div class="strip-cell"><span class="strip-num">${safeNumber(totals.estPriceInr) != null ? escapeHtml(formatInr(safeNumber(totals.estPriceInr) as number)) : '—'}</span><span class="strip-label">Est. cost</span></div>
      <div class="strip-cell accent"><span class="strip-num">${safeSocText(totals.finalSocPct)}<span class="unit">%</span></span><span class="strip-label">Arrival charge</span></div>
    </div>
  `);
  results.appendChild(strip);

  // ---- actions ----
  // Waypoint links depend on coordinates only. A caller may label a real
  // coordinate Unknown; that must not suppress a valid route URL. An unreadable
  // stop list suppresses the whole link rather than implying zero waypoints.
  const mapsLinks = !stopsKnown ? null : routeDirectionsLinks(
    coordinatePoint(raw.origin), coordinatePoint(raw.destination),
    stops.map((stop) => coordinatePoint(record(stop)?.station)),
  );
  const mapsMarkup = !mapsLinks ? '<span class="hint">Google Maps directions unavailable</span>'
    : `<div class="maps-links" aria-label="Google Maps route segments">` +
      mapsLinks.map((link) => {
        const from = link.startsAtOrigin ? 'Origin' : `charger ${link.firstStop}`;
        const to = link.endsAtDestination ? 'destination' : `charger ${link.lastStop}`;
        const range = `${from} → ${to}`;
        const prefix = link.total > 1 ? `Part ${link.part} of ${link.total}: ` : '';
        return `<a class="btn btn-ghost" data-gmaps href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">Google Maps directions — ${escapeHtml(prefix + range)}</a>`;
      }).join('') + '</div>';
  const actions = el(`
    <div class="plan-actions">
      <button type="button" class="btn btn-ghost" data-save>Trip is not saved yet — click to save</button>
      <button type="button" class="btn btn-ghost" data-export>Animated export</button>
      <button type="button" class="btn btn-ghost" data-itinerary-export>Journey itinerary (HTML)</button>
      <button type="button" class="btn btn-ghost" data-print>Print itinerary</button>
      ${mapsMarkup}
    </div>
  `);
  results.appendChild(actions);

  wirePlanActions(actions as HTMLElement, raw as unknown as TripPlan);

  // ---- journey briefing: whole-trip legs, battery profile, itinerary ----
  results.appendChild(el(renderJourneyBriefingMarkup(raw as unknown as TripPlan)));

  // ---- stops timeline ----
  const stopsWrap = el('<div class="stops"></div>');
  if (stopsKnown && stops.length === 0) {
    stopsWrap.appendChild(el('<div class="no-stops">No charging stops needed — the destination is within your charge.</div>'));
  }
  stops.forEach((stop, i) => {
    stopsWrap.appendChild(renderStopCard(stop, i));
  });
  results.appendChild(stopsWrap);
  // Bind after the cards exist: the shared controller checks ID ownership,
  // guards duplicate clicks, discards detached views and stale responses.
  results.querySelectorAll<HTMLElement>('[data-refresh]:not([disabled])').forEach((btn) => {
    const card = btn.closest<HTMLElement>('.stop-card');
    const stationId = safeStationId(Number(btn.dataset.refresh));
    if (card && stationId != null) wireStationEvidence(card, { buttonSelector: '[data-refresh]', stationId });
  });
}

export function markTripDeleted(id: string): void {
  if (typeof id !== 'string' || !id) return;
  for (const button of document.querySelectorAll<HTMLButtonElement>('.plan-results [data-save][data-saved-trip-id]')) {
    if (button.dataset.savedTripId !== id) continue;
    button.disabled = false;
    button.textContent = button.dataset.unsavedLabel ?? 'Trip is not saved yet — click to save';
    delete button.dataset.savedTripId;
    delete button.dataset.unsavedLabel;
  }
}

function wirePlanActions(actions: HTMLElement, plan: TripPlan): void {
  actions.querySelector('[data-save]')?.addEventListener('click', async () => {
    const btn = actions.querySelector<HTMLButtonElement>('[data-save]');
    if (!btn || btn.disabled) return;
    const originalLabel = btn.textContent ?? 'Trip is not saved yet — click to save';
    btn.disabled = true;
    try {
      const response = await api.saveTrip(plan);
      const candidateId = record(response)?.trip && record(record(response)?.trip)?.id;
      const savedTripId = typeof candidateId === 'string' && candidateId.trim().length > 0 ? candidateId : null;
      if (!savedTripId) {
        btn.textContent = 'Save status unknown';
        const banner = storageWarningElement('Save could not be confirmed. Check saved trips before trying again.');
        const controls = el(`<div class="plan-actions"><button type="button" class="btn btn-compact btn-ghost" data-check-saved>Check saved trips</button><button type="button" class="btn btn-compact btn-ghost" data-enable-save>Enable save retry</button></div>`);
        controls.querySelector('[data-check-saved]')?.addEventListener('click', () => {
          if (!btn.isConnected) return;
          const owner = document.getElementById('trips-button');
          if (owner && owner.getAttribute('aria-expanded') !== 'true') owner.click();
        });
        controls.querySelector('[data-enable-save]')?.addEventListener('click', () => {
          if (!btn.isConnected) return;
          btn.textContent = originalLabel;
          btn.disabled = false;
          banner.remove();
          controls.remove();
          btn.focus({ preventScroll: true });
        });
        actions.after(banner, controls);
        return;
      }
      if (savedTripId) { btn.dataset.savedTripId = savedTripId; btn.dataset.unsavedLabel = originalLabel; }
      btn.textContent = 'Saved to your trips';
      const warning = storageWarningText(response);
      if (warning) actions.after(storageWarningElement(`Trip saved. ${warning}`));
      toast(warning ? `Trip saved. ${warning}` : 'Trip saved.', warning ? 'warn' : 'info', warning ? 12_000 : 4_200);
    } catch (err) {
      btn.disabled = false;
      if (document.activeElement === document.body) btn.focus({ preventScroll: true });
      const message = err instanceof Error ? err.message : 'Save failed.';
      toast(message, 'bad');
    }
  });
  actions.querySelector('[data-export]')?.addEventListener('click', () => {
    try {
      downloadAnimatedExport(plan);
      toast('Animated export downloaded.');
    } catch {
      toast('Export failed.', 'bad');
    }
  });
  actions.querySelector('[data-itinerary-export]')?.addEventListener('click', () => {
    try {
      downloadJourneyBriefing(plan);
      toast('Journey itinerary downloaded.');
    } catch {
      toast('Itinerary export failed.', 'bad');
    }
  });
  actions.querySelector('[data-print]')?.addEventListener('click', () => {
    try {
      window.print();
    } catch {
      toast('Print is unavailable in this browser.', 'bad');
    }
  });
}


const SAFE_BRANDS = new Set(['statiq', 'tata', 'bpcl', 'hp', 'other']);

function safeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function coordinatePoint(value: unknown): { lat: unknown; lon: unknown } {
  const point = record(value);
  return { lat: point?.lat, lon: point?.lon };
}

function safeNonNegative(value: unknown): number | null {
  const number = safeNumber(value);
  return number != null && number >= 0 ? number : null;
}

function safeSoc(value: unknown): number | null {
  const number = safeNumber(value);
  return number != null && number >= 0 && number <= 100 ? number : null;
}

function safeDisplay(value: unknown, fallback = 'Unknown'): string {
  return typeof value === 'string' && value.trim().length > 0 ? escapeHtml(value) : fallback;
}

function safeIntegerText(value: unknown): string {
  const number = safeNonNegative(value);
  return number != null ? escapeHtml(String(Math.round(number))) : 'Unknown';
}

function safeSocText(value: unknown): string {
  const number = safeSoc(value);
  return number != null ? escapeHtml(String(Math.round(number))) : 'Unknown';
}

function safeDecimal(value: unknown, digits = 1): string {
  const number = safeNonNegative(value);
  return number != null ? escapeHtml(number.toFixed(digits)) : 'Unknown';
}

function safeTariff(value: unknown): string {
  const number = safeNonNegative(value);
  return number != null ? escapeHtml(formatTariff(number)) : 'Tariff unknown';
}

function renderStopCard(stop: unknown, index: number): HTMLElement {
  const planned = record(stop);
  const s = record(planned?.station) ?? {};
  const inventoryKnown = Array.isArray(s.chargers);
  const chargers = inventoryKnown ? s.chargers as unknown[] : [];
  const stationId = safeStationId(s.stationId);
  const fetchedAt = typeof s.fetchedAt === 'string' ? s.fetchedAt : null;
  const rating = safeNumber(s.rating);
  const ratingKnown = rating != null && rating >= 0 && rating <= 5;
  const rawBrand = typeof s.brand === 'string' ? s.brand.toLowerCase().trim() : '';
  const brandKnown = SAFE_BRANDS.has(rawBrand);
  const brandKey = brandKnown ? rawBrand : 'other';
  const brandLabel = brandKnown
    ? rawBrand.charAt(0).toUpperCase() + rawBrand.slice(1)
    : 'Unknown';
  const directionsUrl = stationDirectionsUrl(s.lat, s.lon);
  // Station page link: the url arrives from upstream data and is untrusted.
  // Only absolute http/https urls survive the allowlist; anything else
  // renders NO link (honest absence) - html-escaping alone below does not
  // stop scheme abuse (javascript: values carry no html-special chars).
  const stationPageUrl = safeHttpUrl(s.stationUrl);
  const card = el(`
    <article class="stop-card timeline" data-stop-index="${index}">
      <div class="stop-rail" aria-hidden="true">
        <span class="stop-node">${index + 1}</span>
        <span class="node-line"></span>
      </div>
      <div class="stop-main">
        <div class="stop-head">
          <div class="stop-title">
            <span class="stop-name">${safeDisplay(s.name)}</span>
            <span class="stop-brand brand-${escapeHtml(brandKey)}">${escapeHtml(brandLabel)}</span>
          </div>
          <span class="stop-tariff">${safeTariff(planned?.pricePerKwh)}</span>
        </div>
        <div class="stop-body">
          <div class="soc-row">
            ${socBar('Arrive', safeSoc(planned?.arriveSocPct))}
            <span class="charge-arrow" title="${safeIntegerText(planned?.chargeKwh)} kWh">${safeIntegerText(planned?.chargeKwh)} kWh</span>
            ${socBar('Leave', safeSoc(planned?.leaveSocPct))}
          </div>
          <div class="stop-stats">
            <span class="stat">Charge ${escapeHtml(formatDuration(safeNonNegative(planned?.chargeTimeMin)))}</span>
            <span class="stat">Arrive at ${escapeHtml(formatEta(safeNonNegative(planned?.arrivalEtaMin)))}</span>
            <span class="stat">Depart at +${escapeHtml(formatEta(safeNonNegative(planned?.departureEtaMin)))}</span>
            <span class="stat">Detour ${safeDecimal(planned?.detourKm)} km</span>
          </div>
          <div class="stop-meta">
            <span class="meta">${ratingKnown
              ? `★ ${Math.round((rating as number) * 10) / 10} (${formatReviewCount(s.reviewCount)} reviews)`
              : 'No rating'}</span>
            <span class="meta">Last used ${inventoryKnown ? escapeHtml(lastUsedLabel(chargers)) : 'Unknown'}</span>
            <span class="meta">Reliability: unavailable</span>
            <span class="meta fetched">Status fetched ${escapeHtml(formatDateTime(fetchedAt))}</span>
          </div>
          ${uncertaintyChips(s, inventoryKnown)}
          ${s.synthetic === true ? '<div class="synthetic-flag">Synthetic station (mock data)</div>' : ''}
          ${renderStationEvidencePanel({
            plannedStation: s,
            plannedFacts: {
              tariffPerKwh: planned?.pricePerKwh as number | null,
              chargeKwh: planned?.chargeKwh as number | null,
              chargeTimeMin: planned?.chargeTimeMin as number | null,
              arrivalEtaMin: planned?.arrivalEtaMin as number | null,
              departureEtaMin: planned?.departureEtaMin as number | null,
              arriveSocPct: planned?.arriveSocPct as number | null,
              leaveSocPct: planned?.leaveSocPct as number | null,
            },
            includeLinks: false,
          })}
        </div>
      </div>
      <div class="stop-foot">
        ${directionsUrl ? `<a class="btn btn-compact btn-ghost" href="${escapeHtml(directionsUrl)}" target="_blank" rel="noreferrer">Directions</a>` : '<span class="hint">Directions unavailable</span>'}
        ${stationPageUrl ? `<a class="btn btn-compact btn-ghost" href="${escapeHtml(stationPageUrl)}" target="_blank" rel="noreferrer">Station page</a>` : ''}
        <button type="button" class="btn btn-compact btn-ghost" data-refresh="${stationId != null ? escapeHtml(String(stationId)) : ''}"${stationId == null ? ' disabled aria-label="Revalidate unavailable — station id Unknown"' : ''}>Revalidate</button>
      </div>
    </article>
  `);
  return card;
}

/** SoC column with an honest tone class (green/amber/red by level). */
function socBar(labelText: string, soc: number | null): string {
  if (soc == null) {
    return `
    <div class="soc-col low">
      <span class="soc-label">${labelText}</span>
      <span class="soc-bar" role="img" aria-label="${labelText} Unknown"></span>
      <span class="soc-value">Unknown</span>
    </div>`;
  }
  const pct = Math.max(0, Math.min(100, soc));
  const tone = soc >= 45 ? '' : soc >= 20 ? ' mid' : ' low';
  return `
    <div class="soc-col${tone}">
      <span class="soc-label">${labelText}</span>
      <div class="soc-bar" role="img" aria-label="${labelText} ${Math.round(soc)}%">
        <span class="soc-fill" style="width:${pct}%"></span>
      </div>
      <span class="soc-value">${Math.round(soc)}%</span>
    </div>`;
}

function uncertaintyChips(station: unknown, inventoryKnown = true): string {
  if (!inventoryKnown) {
    return '<div class="chips"><span class="chip chip-uncertain">Charger inventory Unknown</span></div>';
  }
  const chips: string[] = [];
  const s = record(station) ?? {};
  const chargers = Array.isArray(s.chargers) ? s.chargers as unknown[] : [];
  const plugsOf = (charger: unknown): unknown[] => {
    const c = record(charger);
    return c != null && Array.isArray(c.plugs) ? c.plugs as unknown[] : [];
  };
  const plugsKnown = chargers.every((charger) => Array.isArray(record(charger)?.plugs));
  const anyContradiction = chargers.some((ch) => plugsOf(ch).some((p) => record(p)?.contradiction === true));
  if (anyContradiction) chips.push('<span class="chip chip-uncertain">Status uncertain</span>');
  const faulted = chargers.some((ch) => plugsOf(ch).some((p) => record(p)?.health === 'faulted'));
  if (faulted) chips.push('<span class="chip chip-bad">Some plugs faulted</span>');
  if (!plugsKnown) {
    chips.push('<span class="chip chip-uncertain">Plug inventory Unknown</span>');
  } else {
    const ccs2 = chargers.some((ch) => {
      const charger = record(ch);
      return connectorSlug(typeof charger?.type === 'string' ? charger.type : '') === 'dc' &&
        plugsOf(ch).some((p) => {
          const plug = record(p);
          return connectorSlug(typeof plug?.type === 'string' ? plug.type : '') === 'ccs2';
        });
    });
    if (!ccs2) chips.push('<span class="chip chip-warn">No CCS2 DC found for this car</span>');
  }
  return chips.length > 0 ? `<div class="chips">${chips.join('')}</div>` : '';
}
