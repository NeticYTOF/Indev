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
import { toast } from './toast.js';
import { formatDuration } from './format.js';

export function renderTripsDrawer(drawer: HTMLElement, map: maplibregl.Map): void {
  drawer.innerHTML = '';
  const head = el(`
    <div class="drawer-head">
      <h2>Saved trips</h2>
      <button type="button" class="btn btn-ghost btn-compact" data-close>Close</button>
    </div>
  `);
  drawer.appendChild(head);
  head.querySelector('[data-close]')?.addEventListener('click', () => {
    drawer.classList.add('hidden');
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
        list.appendChild(renderTripRow(trip, map, drawer));
      }
    } catch (err) {
      list.innerHTML = '';
      list.appendChild(el(`<p class="hint">Could not load trips: ${escapeHtml(err instanceof Error ? err.message : 'unknown error')}</p>`));
    }
  };
  void load();
}

function renderTripRow(trip: SavedTrip, map: maplibregl.Map, drawer: HTMLElement): HTMLElement {
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
        <button type="button" class="btn btn-compact btn-danger-ghost" data-delete>Delete</button>
      </div>
    </div>
  `);

  row.querySelector('[data-open]')?.addEventListener('click', () => {
    drawer.classList.add('hidden');
    openSavedTrip(trip, map);
  });

  row.querySelector('[data-delete]')?.addEventListener('click', async () => {
    try {
      const res = await api.deleteTrip(trip.id);
      if (res.ok) {
        renderTripsDrawer(drawer, map); // refresh list
        toast('Trip deleted.');
      } else {
        toast('Could not delete the trip.', 'bad');
      }
    } catch {
      toast('Could not delete the trip.', 'bad');
    }
  });

  return row;
}

/** Draw a saved trip on the map (refs only) and show a ref-based summary. */
function openSavedTrip(trip: SavedTrip, map: maplibregl.Map): void {
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
  renderSavedSummary(panel, trip);
  if (window.innerWidth <= 720) {
    panel.classList.add('open');
  }
  toast('Saved trip loaded — station cards fetch current details on request.');
}

function renderSavedSummary(panel: HTMLElement, trip: SavedTrip): void {
  let results = panel.querySelector<HTMLElement>('.plan-results');
  if (!results) {
    results = el('<section class="plan-results" aria-label="Saved trip"></section>') as HTMLElement;
    panel.appendChild(results);
  }
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
        ${escapeHtml(trip.vehicle.label)}${trip.vehicle.realWorldRangeKm != null ? ` · your real-world range ${trip.vehicle.realWorldRangeKm} km` : ''}${trip.vehicle.claimedRangeKm != null ? ` · claim ${trip.vehicle.claimedRangeKm} km (mfr)` : ''}
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
    <div class="stops saved-stops">
      ${trip.stations
        .map(
          (s, i) => `
        <article class="stop-card timeline saved-stop" data-station-id="${s.stationId}">
          <div class="stop-rail" aria-hidden="true">
            <span class="stop-node">${i + 1}</span>
            <span class="node-line"></span>
          </div>
          <div class="stop-main">
            <div class="stop-head">
              <div class="stop-title"><span class="stop-name">${escapeHtml(s.name)}</span></div>
              <button type="button" class="btn btn-compact btn-ghost" data-revalidate>Fetch current details</button>
            </div>
            <div class="stop-body revalidate-box hidden"></div>
          </div>
        </article>`,
        )
        .join('')}
    </div>
  `;

  results.querySelectorAll<HTMLElement>('[data-revalidate]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.stop-card') as HTMLElement;
      const stationId = Number(card.dataset.stationId);
      const box = card.querySelector('.revalidate-box') as HTMLElement;
      box.classList.remove('hidden');
      box.textContent = 'Fetching station details…';
      try {
        const res = await fetch(`/api/stations/${stationId}`);
        if (!res.ok) {
          box.textContent = 'Station details unavailable right now.';
          return;
        }
        const { station } = (await res.json()) as {
          station: {
            name: string;
            rating: number | null;
            reviewCount: number | null;
            reliability: null;
            synthetic?: boolean;
            fetchedAt: string;
            ccs2: { usable: number; free: number; occupied: number; faulted: number; uncertain: number; maxKw: number | null; pricePerKwh: number | null };
            chargers: Array<{ lastUsedOn: string | null; kw: number; type: string; pricePerKwh: number | null; connectors: Array<{ type: string; status: string; note: string | null }> }>;
          };
        };
        const lastUsed = station.chargers.map((c) => c.lastUsedOn).filter(Boolean).join(', ') || 'unknown';
        box.innerHTML = `
          ${station.synthetic ? '<div class="banner banner-synthetic">Synthetic station (mock mode) — a fixed sample, not live charger data.</div>' : ''}
          <div class="stop-meta">
            <span class="meta">${station.rating != null ? `★ ${Math.round(station.rating * 10) / 10} (${(station.reviewCount ?? 0).toLocaleString('en-IN')} reviews)` : 'No rating'}</span>
            <span class="meta">Last used ${escapeHtml(lastUsed)}${station.synthetic ? ' (fixture)' : ''}</span>
            <span class="meta">Reliability: unavailable</span>
            <span class="meta fetched">Details fetched just now</span>
          </div>
          <div class="chips">
            <span class="chip">${station.ccs2.usable} usable CCS2 plug${station.ccs2.usable === 1 ? '' : 's'}</span>
            ${station.ccs2.faulted > 0 ? '<span class="chip chip-bad">Faulted plugs</span>' : ''}
            ${station.ccs2.uncertain > 0 ? '<span class="chip chip-uncertain">Uncertain status</span>' : ''}
            ${station.synthetic ? '<span class="chip chip-synthetic">Synthetic</span>' : ''}
          </div>`;
      } catch {
        box.textContent = 'Station details unavailable right now.';
      }
    });
  });
}
