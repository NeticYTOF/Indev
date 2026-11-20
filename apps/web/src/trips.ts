/**
 * Saved trips drawer: list, load (redraws route), delete.
 * Saved trips hold minimal station references; opening one draws the saved
 * geometry and lets each stop revalidate live via the station endpoint.
 * Night Drive markup; all flows unchanged.
 */
import * as maplibregl from 'maplibre-gl';
import type { SavedTrip } from '@indeev/core';
import { api } from './api.js';
import { el, escapeHtml } from './planner.js';
import { drawTrip } from './map.js';
import {
  downloadJourneyBriefing,
  journeySourceFromSavedTrip,
  renderJourneyBriefingMarkup,
} from './journey-briefing.js';
import { toast } from './toast.js';
import { buildSavedRouteDraft } from './saved-route.js';
import type { SavedRouteDraft } from './saved-route.js';
import { renderStationEvidencePanel, wireStationEvidence } from './station-evidence-panel.js';
import { storageWarningText, storageWarningElement } from './storage-warning.js';
import { formatDuration } from './format.js';

/**
 * Hide the saved-trips drawer. Closing it leaves every in-drawer focus
 * target display:none - without an explicit move, keyboard focus silently
 * falls to <body> and the user restarts from the top of the tab order.
 * Focus is restored ONLY when the hide actually destroyed it (focus was
 * inside the drawer); an Escape pressed while typing in a planner field
 * must not yank focus from that field.
 */
export function hideTripsDrawer(drawer: HTMLElement): void {
  const focusInside = drawer.contains(document.activeElement);
  drawer.classList.add('hidden');
  if (focusInside) {
    document.getElementById('trips-button')?.focus();
  }
}

type LoadSavedRoute = (draft: SavedRouteDraft) => boolean;

export function renderTripsDrawer(
  drawer: HTMLElement,
  map: maplibregl.Map,
  loadSavedRoute: LoadSavedRoute,
): void {
  drawer.innerHTML = '';
  const head = el(`
    <div class="drawer-head">
      <h2>Saved trips</h2>
      <button type="button" class="btn btn-ghost btn-compact" data-close>Close</button>
    </div>
  `);
  drawer.appendChild(head);
  head.querySelector('[data-close]')?.addEventListener('click', () => {
    hideTripsDrawer(drawer);
  });

  const list = el('<div class="trip-list"></div>');
  drawer.appendChild(list);

  const load = async (): Promise<void> => {
    list.innerHTML = '<p class="hint">Loading…</p>';
    try {
      const { trips } = await api.trips();
      list.innerHTML = '';
      if (trips.length === 0) {
        list.appendChild(el('<p class="hint">No saved trips yet. Plan a route, then save it.</p>'));
        return;
      }
      for (const trip of trips) {
        list.appendChild(renderTripRow(trip, map, drawer, loadSavedRoute));
      }
    } catch (err) {
      list.innerHTML = '';
      list.appendChild(el(`<p class="hint">Could not load trips: ${escapeHtml(err instanceof Error ? err.message : 'unknown error')}</p>`));
    }
  };
  void load();
}

function renderTripRow(
  trip: SavedTrip,
  map: maplibregl.Map,
  drawer: HTMLElement,
  loadSavedRoute: LoadSavedRoute,
): HTMLElement {
  const row = el(`
    <div class="trip-row">
      <div class="trip-main">
        <span class="trip-name">${escapeHtml(trip.name)}</span>
        <span class="trip-sub">
          ${escapeHtml(trip.origin.label)} → ${escapeHtml(trip.destination.label)}
          · ${Math.round(trip.routeDistanceKm)} km
          · ${trip.stations.length} stop${trip.stations.length === 1 ? '' : 's'}
          · ${escapeHtml(formatDuration(trip.totals.totalTimeMin))}
          ${trip.source === 'synthetic' ? '· <span class="synthetic-note">synthetic</span>' : ''}
          ${trip.status === 'degraded' ? '· <span class="degraded-note">degraded</span>' : ''}
        </span>
      </div>
      <div class="trip-actions">
        <button type="button" class="btn btn-compact btn-ghost" data-open>Open</button>
        <button type="button" class="btn btn-compact btn-ghost" data-edit>Edit route</button>
        <button type="button" class="btn btn-compact btn-danger-ghost" data-delete>Delete</button>
      </div>
    </div>
  `);

  row.querySelector('[data-open]')?.addEventListener('click', () => {
    drawer.classList.add('hidden'); // hide directly: focus lands on the
    // trip summary below, not on the drawer's owner control
    openSavedTrip(trip, map, loadSavedRoute);
  });

  row.querySelector('[data-edit]')?.addEventListener('click', () => {
    // Only copy into the composer. No plan, geocode, station or AI request
    // starts here, and the saved trip itself is never modified.
    if (!loadSavedRoute(buildSavedRouteDraft(trip))) return;
    hideTripsDrawer(drawer);
    toast('Saved route loaded for review — plan manually when ready.');
  });

  row.querySelector('[data-delete]')?.addEventListener('click', async () => {
    const btn = row.querySelector<HTMLButtonElement>('[data-delete]');
    // Single-flight: a second click during the flight would fire a
    // duplicate DELETE (the 404 it gets would toast a false 'Could not
    // delete' right after the first one succeeded).
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    try {
      const res = await api.deleteTrip(trip.id);
      const body: unknown = await res.json().catch(() => null);
      const warning = storageWarningText(body);
      if (res.ok) {
        // The refresh below replaces the drawer's DOM wholesale - the
        // clicked button dies with it. Land focus on the stable owner
        // control before that, instead of letting it fall to <body>.
        if (document.activeElement === document.body || drawer.contains(document.activeElement)) {
          document.getElementById('trips-button')?.focus();
        }
        renderTripsDrawer(drawer, map, loadSavedRoute); // refresh list
        if (warning) drawer.querySelector('.drawer-head')?.after(storageWarningElement(`Trip deleted. ${warning}`));
        toast(warning ? `Trip deleted. ${warning}` : 'Trip deleted.', warning ? 'warn' : 'info', warning ? 12_000 : 4_200);
      } else {
        if (warning) drawer.querySelector('.drawer-head')?.after(storageWarningElement(warning));
        btn.disabled = false;
        if (document.activeElement === document.body) btn.focus();
        toast('Could not delete the trip.', 'bad');
      }
    } catch {
      btn.disabled = false;
      if (document.activeElement === document.body) btn.focus();
      toast('Could not delete the trip.', 'bad');
    }
  });

  return row;
}

/** Draw a saved trip on the map (refs only) and show a ref-based summary. */
function openSavedTrip(
  trip: SavedTrip,
  map: maplibregl.Map,
  loadSavedRoute: LoadSavedRoute,
): void {
  drawTrip(map, {
    geometry: trip.geometry.map(([lat, lon]) => [lon, lat] as [number, number]),
    origin: trip.origin,
    destination: trip.destination,
    stops: trip.stations.map((s) => ({
      lat: s.lat,
      lon: s.lon,
      label: s.name,
      brand: 'other',
    })),
  });
  const panel = document.getElementById('planner-panel') as HTMLElement;
  renderSavedSummary(panel, trip, loadSavedRoute);
  if (window.innerWidth <= 720) {
    panel.classList.add('open');
    document.getElementById('sheet-open')?.setAttribute('aria-expanded', 'true');
    document.getElementById('sheet-open')?.classList.add('hidden');
  }
  // The button that opened this trip vanished with the drawer - land
  // focus on the attention target (the freshly rendered summary) instead
  // of letting it fall to <body>. After the sheet opens, so the target is
  // visible (hidden elements are not focusable).
  panel.querySelector<HTMLElement>('.plan-results')?.focus();
  toast('Saved trip loaded — station cards fetch current details on request.');
}

function renderSavedSummary(
  panel: HTMLElement,
  trip: SavedTrip,
  loadSavedRoute: LoadSavedRoute,
): void {
  let results = panel.querySelector<HTMLElement>('.plan-results');
  if (!results) {
    results = el('<section class="plan-results" aria-label="Saved trip"></section>') as HTMLElement;
    panel.appendChild(results);
  }
  // The section may be REUSED from a live plan (no tabindex there): make
  // it programmatically focusable so openSavedTrip can land focus on it.
  results.setAttribute('tabindex', '-1');
  results.innerHTML = `
    <div class="banners">
      ${trip.source === 'synthetic' ? '<div class="banner banner-synthetic">Synthetic saved trip (mock data).</div>' : ''}
      ${trip.status === 'degraded' ? '<div class="banner banner-warn">This plan was saved with partial charger coverage (degraded).</div>' : ''}
      <div class="banner banner-soft">
        Saved on ${escapeHtml(new Date(trip.createdAt).toLocaleString('en-IN'))}.
        Charger status is never stored — station cards below fetch current
        details on request (labelled synthetic in mock mode).
      </div>
    </div>
    <div class="plan-head">
      <div class="plan-route">
        <span class="origin">${escapeHtml(trip.origin.label)}</span>
        <span class="arrow">→</span>
        <span class="destination">${escapeHtml(trip.destination.label)}</span>
      </div>
      <div class="plan-vehicle">
        ${escapeHtml(trip.vehicle.label)}${trip.vehicle.realWorldRangeKm != null ? ` · your real-world range ${escapeHtml(String(trip.vehicle.realWorldRangeKm))} km` : ''}${trip.vehicle.claimedRangeKm != null ? ` · claim ${escapeHtml(String(trip.vehicle.claimedRangeKm))} km (mfr)` : ''}
      </div>
    </div>
    <div class="trip-strip">
      <div class="strip-cell"><span class="strip-num">${escapeHtml(formatDuration(trip.totals.totalTimeMin))}</span><span class="strip-label">Total time</span></div>
      <div class="strip-cell"><span class="strip-num">${Math.round(trip.routeDistanceKm)}<span class="unit">km</span></span><span class="strip-label">Distance</span></div>
      <div class="strip-cell"><span class="strip-num">${trip.stations.length}</span><span class="strip-label">Charging stop${trip.stations.length === 1 ? '' : 's'}</span></div>
      <div class="strip-cell"><span class="strip-num">${trip.totals.estPriceInr != null ? escapeHtml(`Rs. ${Math.round(trip.totals.estPriceInr).toLocaleString('en-IN')}`) : '—'}</span><span class="strip-label">Est. cost</span></div>
      <div class="strip-cell accent"><span class="strip-num">${Math.round(trip.totals.finalSocPct)}<span class="unit">%</span></span><span class="strip-label">Arrival charge</span></div>
      <div class="strip-cell"><span class="strip-num">${escapeHtml(formatDuration(trip.totals.chargeTimeMin))}</span><span class="strip-label">Charging time</span></div>
    </div>
    <div class="plan-actions saved-briefing-actions">
      <button type="button" class="btn btn-ghost" data-edit-saved>Edit route</button>
      <button type="button" class="btn btn-ghost" data-itinerary-export>Journey itinerary (HTML)</button>
      <button type="button" class="btn btn-ghost" data-print>Print itinerary</button>
    </div>
    <div class="stops saved-stops">
      ${trip.stations
        .map(
          (s, i) => `
        <article class="stop-card timeline saved-stop" data-station-id="${escapeHtml(String(s.stationId))}">
          <div class="stop-rail" aria-hidden="true">
            <span class="stop-node">${i + 1}</span>
            <span class="node-line"></span>
          </div>
          <div class="stop-main">
            <div class="stop-head">
              <div class="stop-title"><span class="stop-name">${escapeHtml(s.name)}</span></div>
              <button type="button" class="btn btn-compact btn-ghost" data-revalidate>Fetch current details</button>
            </div>
            <div class="stop-body">
              ${renderStationEvidencePanel({
                savedStation: s,
                plannedFacts: {
                  tariffPerKwh: s.pricePerKwh,
                  chargeKwh: s.chargeKwh,
                  chargeTimeMin: s.chargeTimeMin,
                  arriveSocPct: s.arriveSocPct,
                  leaveSocPct: s.leaveSocPct,
                },
              })}
            </div>
          </div>
        </article>`,
        )
        .join('')}
    </div>
  `;

  results.querySelector('[data-edit-saved]')?.addEventListener('click', () => {
    // The summary is replaced by the composer draft; storage is untouched.
    loadSavedRoute(buildSavedRouteDraft(trip));
  });

  const source = journeySourceFromSavedTrip(trip);
  const briefing = el(renderJourneyBriefingMarkup(source));
  results.querySelector('.saved-stops')?.before(briefing);
  results.querySelector('[data-itinerary-export]')?.addEventListener('click', () => {
    try {
      downloadJourneyBriefing(source);
      toast('Journey itinerary downloaded.');
    } catch {
      toast('Itinerary export failed.', 'bad');
    }
  });
  results.querySelector('[data-print]')?.addEventListener('click', () => {
    try {
      window.print();
    } catch {
      toast('Print is unavailable in this browser.', 'bad');
    }
  });

  results.querySelectorAll<HTMLElement>('.saved-stop').forEach((card, index) => {
    const station = trip.stations[index];
    if (station) wireStationEvidence(card, {
      buttonSelector: '[data-revalidate]',
      stationId: station.stationId,
    });
  });
}
