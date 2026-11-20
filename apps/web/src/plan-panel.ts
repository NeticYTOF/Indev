/**
 * Plan results: honest banners (degraded / synthetic / warnings), hero
 * trip strip, and the charging-stop timeline: numbered rail nodes, per-stop
 * battery in/out with charge between, tariff price, times, rating/reviews,
 * last-used, reliability (unavailable), uncertainty chips, fetched-at
 * freshness, Google Maps directions link.
 */
import * as maplibregl from 'maplibre-gl';
import type { TripPlan, PlanStop } from '@indeev/core';
import { el, escapeHtml } from './planner.js';
import { api } from './api.js';
import { downloadAnimatedExport } from './export.js';
import { downloadJourneyBriefing, renderJourneyBriefingMarkup } from './journey-briefing.js';
import { toast } from './toast.js';
import { storageWarningText, storageWarningElement } from './storage-warning.js';
import { formatReviewCount, formatDuration, formatEta, formatInr, lastUsedLabel, formatDateTime, formatTariff } from './format.js';
import { safeHttpUrl, stationDirectionsUrl, routeDirectionsUrl } from './safe-url.js';

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

  // ---- banners ----
  const banners = el('<div class="banners"></div>');
  if (plan.source === 'synthetic') {
    banners.appendChild(el('<div class="banner banner-synthetic">Synthetic data — this plan comes from mock mode, not live chargers.</div>'));
  }
  if (plan.status === 'degraded') {
    banners.appendChild(el('<div class="banner banner-warn">Coverage incomplete: some route samples or station evidence could not be verified. Treat charger coverage as partial.</div>'));
  }
  for (const w of plan.warnings) {
    banners.appendChild(el(`<div class="banner banner-warn">${escapeHtml(w)}</div>`));
  }
  if (banners.childElementCount > 0) results.appendChild(banners);

  // ---- header ----
  const head = el(`
    <div class="plan-head">
      <div class="plan-route">
        <span class="origin">${escapeHtml(plan.origin.label)}</span>
        <span class="arrow">→</span>
        <span class="destination">${escapeHtml(plan.destination.label)}</span>
      </div>
      <div class="plan-vehicle">${escapeHtml(plan.vehicle.label)}${plan.vehicle.realWorldRangeKm != null ? ` · your real-world range ${plan.vehicle.realWorldRangeKm} km` : ''}${plan.vehicle.claimedRangeKm != null ? ` · claim ${plan.vehicle.claimedRangeKm} km (mfr)` : ''}</div>
    </div>
  `);
  results.appendChild(head);

  // ---- hero trip strip ----
  const strip = el(`
    <div class="trip-strip">
      <div class="strip-cell"><span class="strip-num">${escapeHtml(formatDuration(plan.totals.totalTimeMin))}</span><span class="strip-label">Total time</span></div>
      <div class="strip-cell"><span class="strip-num">${Math.round(plan.routeDistanceKm)}<span class="unit">km</span></span><span class="strip-label">Distance</span></div>
      <div class="strip-cell"><span class="strip-num">${escapeHtml(String(plan.stops.length))}</span><span class="strip-label">Charging stop${plan.stops.length === 1 ? '' : 's'}</span></div>
      <div class="strip-cell"><span class="strip-num">${escapeHtml(formatDuration(plan.totals.chargeTimeMin))}</span><span class="strip-label">Charging time</span></div>
      <div class="strip-cell"><span class="strip-num">${plan.totals.estPriceInr != null ? escapeHtml(formatInr(plan.totals.estPriceInr)) : '—'}</span><span class="strip-label">Est. cost</span></div>
      <div class="strip-cell accent"><span class="strip-num">${Math.round(plan.totals.finalSocPct)}<span class="unit">%</span></span><span class="strip-label">Arrival charge</span></div>
    </div>
  `);
  results.appendChild(strip);

  // ---- actions ----
  const mapsUrl = routeDirectionsUrl(plan.origin, plan.destination, plan.stops.map(stop => stop.station));
  const actions = el(`
    <div class="plan-actions">
      <button type="button" class="btn btn-ghost" data-save>Trip is not saved yet — click to save</button>
      <button type="button" class="btn btn-ghost" data-export>Animated export</button>
      <button type="button" class="btn btn-ghost" data-itinerary-export>Journey itinerary (HTML)</button>
      <button type="button" class="btn btn-ghost" data-print>Print itinerary</button>
      ${mapsUrl ? `<a class="btn btn-ghost" data-gmaps href="${escapeHtml(mapsUrl)}" target="_blank" rel="noreferrer">Google Maps directions</a>` : '<span class="hint">Google Maps directions unavailable</span>'}
    </div>
  `);
  results.appendChild(actions);

  wirePlanActions(actions as HTMLElement, plan);

  // ---- journey briefing: whole-trip legs, battery profile, itinerary ----
  results.appendChild(el(renderJourneyBriefingMarkup(plan)));

  // ---- stops timeline ----
  const stopsWrap = el('<div class="stops"></div>');
  if (plan.stops.length === 0) {
    stopsWrap.appendChild(el('<div class="no-stops">No charging stops needed — the destination is within your charge.</div>'));
  }
  plan.stops.forEach((stop, i) => {
    stopsWrap.appendChild(renderStopCard(stop, i));
  });
  results.appendChild(stopsWrap);
  // Bind after the cards exist: before append, this query matched nothing.
  results.querySelectorAll<HTMLElement>('[data-refresh]').forEach((btn) => {
    btn.addEventListener('click', () => void revalidateStop(btn, plan));
  });
}

function wirePlanActions(actions: HTMLElement, plan: TripPlan): void {
  actions.querySelector('[data-save]')?.addEventListener('click', async () => {
    const btn = actions.querySelector<HTMLButtonElement>('[data-save]');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    try {
      const response = await api.saveTrip(plan);
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

async function revalidateStop(btn: HTMLElement, plan: TripPlan): Promise<void> {
  if (btn.hasAttribute('disabled')) return;
  const stationId = Number(btn.dataset.refresh);
  const card = btn.closest('.stop-card') as HTMLElement | null;
  if (!card) return;
  const index = Number(card.dataset.stopIndex);
  const stop = plan.stops[index];
  if (!stop || stop.station.stationId !== stationId) return;
  const box = card.querySelector<HTMLElement>('.revalidate-box') ?? document.createElement('div');
  box.className = 'revalidate-box';
  box.textContent = 'Fetching station status…';
  if (!box.isConnected) card.querySelector('.stop-body')?.appendChild(box);
  btn.setAttribute('disabled', 'true');
  try {
    const res = await fetch(`/api/stations/${stationId}`);
    if (!res.ok) {
      box.textContent = 'Station details unavailable right now.';
      return;
    }
    const { station } = (await res.json()) as {
      station: {
        rating: number | null;
        reviewCount: number | null;
        reliability: null;
        synthetic?: boolean;
        fetchedAt?: string;
        ccs2: { usable: number; free: number; occupied: number; faulted: number; uncertain: number; maxKw: number | null; pricePerKwh: number | null };
        chargers: Array<{ lastUsedOn: string | null }>;
      };
    };
    const lastUsed = lastUsedLabel(station.chargers);
    box.innerHTML = `
      ${station.synthetic ? '<div class="banner banner-synthetic">Synthetic station (mock mode) — a fixed sample, not live charger data.</div>' : ''}
      <div class="stop-meta">
        <span class="meta">${station.rating != null ? `★ ${Math.round(station.rating * 10) / 10} (${formatReviewCount(station.reviewCount)} reviews)` : 'No rating'}</span>
        <span class="meta">Last used ${escapeHtml(String(lastUsed))}${station.synthetic ? ' (fixture)' : ''}</span>
        <span class="meta">Reliability: unavailable</span>
        <span class="meta fetched">Details fetched ${escapeHtml(formatDateTime(station.fetchedAt))}</span>
      </div>
      <div class="chips">
        <span class="chip">${station.ccs2.usable} usable CCS2 plug${station.ccs2.usable === 1 ? '' : 's'}</span>
        ${station.ccs2.free > 0 ? `<span class="chip">${station.ccs2.free} free</span>` : ''}
        ${station.ccs2.faulted > 0 ? '<span class="chip chip-bad">Faulted plugs</span>' : ''}
        ${station.ccs2.uncertain > 0 ? '<span class="chip chip-uncertain">Uncertain status</span>' : ''}
        ${station.synthetic ? '<span class="chip chip-synthetic">Synthetic</span>' : ''}
      </div>`;
  } catch {
    box.textContent = 'Station details unavailable right now.';
  } finally {
    // Manual refresh can be used again after either outcome, never retried
    // automatically. Reuse one status box rather than accumulating panels.
    btn.removeAttribute('disabled');
    if (document.activeElement === document.body) btn.focus({ preventScroll: true });
  }
}

function renderStopCard(stop: PlanStop, index: number): HTMLElement {
  const s = stop.station;
  const brandLabel = s.brand.charAt(0).toUpperCase() + s.brand.slice(1);
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
            <span class="stop-name">${escapeHtml(s.name)}</span>
            <span class="stop-brand brand-${s.brand}">${brandLabel}</span>
          </div>
          <span class="stop-tariff">${stop.pricePerKwh != null ? escapeHtml(formatTariff(stop.pricePerKwh)) : 'Tariff unknown'}</span>
        </div>
        <div class="stop-body">
          <div class="soc-row">
            ${socBar('Arrive', stop.arriveSocPct)}
            <span class="charge-arrow" title="${Math.round(stop.chargeKwh)} kWh">${Math.round(stop.chargeKwh)} kWh</span>
            ${socBar('Leave', stop.leaveSocPct)}
          </div>
          <div class="stop-stats">
            <span class="stat">Charge ${formatDuration(stop.chargeTimeMin)}</span>
            <span class="stat">Arrive at ${formatEta(stop.arrivalEtaMin)}</span>
            <span class="stat">Depart at +${formatEta(stop.departureEtaMin)}</span>
            <span class="stat">Detour ${stop.detourKm.toFixed(1)} km</span>
          </div>
          <div class="stop-meta">
            <span class="meta">${s.rating != null ? `★ ${Math.round(s.rating * 10) / 10} (${formatReviewCount(s.reviewCount)} reviews)` : 'No rating'}</span>
            <span class="meta">Last used ${escapeHtml(lastUsedLabel(s.chargers))}</span>
            <span class="meta">Reliability: unavailable</span>
            <span class="meta fetched">Status fetched ${escapeHtml(formatDateTime(s.fetchedAt))}</span>
          </div>
          ${uncertaintyChips(s)}
          ${s.synthetic ? '<div class="synthetic-flag">Synthetic station (mock data)</div>' : ''}
        </div>
      </div>
      <div class="stop-foot">
        ${directionsUrl ? `<a class="btn btn-compact btn-ghost" href="${escapeHtml(directionsUrl)}" target="_blank" rel="noreferrer">Directions</a>` : '<span class="hint">Directions unavailable</span>'}
        ${stationPageUrl ? `<a class="btn btn-compact btn-ghost" href="${escapeHtml(stationPageUrl)}" target="_blank" rel="noreferrer">Station page</a>` : ''}
        <button type="button" class="btn btn-compact btn-ghost" data-refresh="${s.stationId}">Revalidate</button>
      </div>
    </article>
  `);
  return card;
}

/** SoC column with an honest tone class (green/amber/red by level). */
function socBar(labelText: string, soc: number): string {
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

function uncertaintyChips(s: PlanStop['station']): string {
  const chips: string[] = [];
  const anyContradiction = s.chargers.some((ch) => ch.plugs.some((p) => p.contradiction));
  if (anyContradiction) chips.push('<span class="chip chip-uncertain">Status uncertain</span>');
  const faulted = s.chargers.some((ch) => ch.plugs.some((p) => p.health === 'faulted'));
  if (faulted) chips.push('<span class="chip chip-bad">Some plugs faulted</span>');
  const ccs2 = s.chargers.some((ch) => ch.type === 'DC' && ch.plugs.some((p) => p.type.toLowerCase().includes('ccs')));
  if (!ccs2) chips.push('<span class="chip chip-warn">No CCS2 DC found for this car</span>');
  return chips.length > 0 ? `<div class="chips">${chips.join('')}</div>` : '';
}
