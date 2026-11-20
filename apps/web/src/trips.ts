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
import { clearTrip, drawTrip } from './map.js';
import {
  downloadJourneyBriefing,
  journeySourceFromSavedTrip,
  renderJourneyBriefingMarkup,
} from './journey-briefing.js';
import { toast } from './toast.js';
import { buildReturnRouteDraft, buildSavedRouteDraft } from './saved-route.js';
import type { SavedRouteDraft } from './saved-route.js';
import { renderStationEvidencePanel, wireStationEvidence } from './station-evidence-panel.js';
import { safeStationId } from './station-evidence.js';
import { storageWarningText, storageWarningElement } from './storage-warning.js';
import { formatDuration } from './format.js';
import { savedRouteGeometry } from './safe-url.js';
import { buildTripComparison } from './trip-compare.js';
import { clearTripComparisonView, renderTripComparisonWorkspace } from './trip-compare-view.js';
import {
  filterAndSortTrips,
  type TripListSort,
  type TripSourceFilter,
  type TripStatusFilter,
} from './trip-list.js';

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

/**
 * In-memory drawer view state for the current page only. It is deliberately
 * never written to storage: route labels stay private to the open tab and a
 * page reload returns to the default view.
 */
const tripDrawerSession: {
  query: string;
  sort: TripListSort;
  source: TripSourceFilter;
  status: TripStatusFilter;
} = { query: '', sort: 'newest', source: 'all', status: 'all' };

function sourceFilterValue(value: string): TripSourceFilter {
  return value === 'live' || value === 'synthetic' || value === 'unknown' ? value : 'all';
}

function statusFilterValue(value: string): TripStatusFilter {
  return value === 'ok' || value === 'degraded' || value === 'unknown' ? value : 'all';
}

function safeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeText(value: unknown, fallback = 'Unknown'): string {
  return typeof value === 'string' && value.trim().length > 0 ? escapeHtml(value) : fallback;
}

function safeInteger(value: unknown): string {
  const number = safeNumber(value);
  return number != null && number >= 0 ? escapeHtml(String(Math.round(number))) : 'Unknown';
}

function safeSocText(value: unknown): string {
  const number = safeNumber(value);
  return number != null && number >= 0 && number <= 100
    ? escapeHtml(String(Math.round(number)))
    : 'Unknown';
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function coordinate(value: unknown): { lat: number; lon: number } | null {
  const point = record(value);
  const lat = point?.lat;
  const lon = point?.lon;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
      typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

interface SavedMapTrip {
  geometry: Array<[number, number]>; // [lon, lat]
  origin: { lat: number; lon: number; label: string };
  destination: { lat: number; lon: number; label: string };
  stops: Array<{ lat: number; lon: number; label: string; brand: string }>;
}

/**
 * Validate the WHOLE saved route before touching the map. An invalid vertex
 * rejects the drawing; the route is never filtered, stitched across gaps or
 * silently shortened. Callers show an explicit notice instead.
 */
function savedMapTrip(trip: unknown): SavedMapTrip | null {
  const raw = record(trip);
  if (!raw) return null;
  // SavedTrip.geometry is [lat, lon][]; the shared helper reverses the whole
  // validated tuple array to MapLibre order. No vertex pruning or repair.
  const geometry = savedRouteGeometry(raw.geometry);
  if (!geometry) return null;
  const origin = coordinate(raw.origin);
  const destination = coordinate(raw.destination);
  if (!origin || !destination) return null;
  // A missing list is not zero stops. The summary shows that the itinerary is
  // incomplete; the known route geometry itself is still drawn unchanged.
  const stations = Array.isArray(raw.stations) ? raw.stations : [];
  const stops: SavedMapTrip['stops'] = [];
  for (const station of stations) {
    const s = record(station);
    const point = coordinate(s);
    if (!s || !point) return null;
    stops.push({
      lat: point.lat, lon: point.lon,
      label: typeof s.name === 'string' && s.name.trim().length > 0 ? s.name : 'Unknown station',
      brand: 'other',
    });
  }
  return {
    geometry,
    origin: { ...origin, label: safeText(record(raw.origin)?.label, 'Origin') },
    destination: { ...destination, label: safeText(record(raw.destination)?.label, 'Destination') },
    stops,
  };
}

export function renderTripsDrawer(
  drawer: HTMLElement,
  map: maplibregl.Map,
  loadSavedRoute: LoadSavedRoute,
): void {
  drawer.innerHTML = '';
  const selected = new Set<number>();
  let loadedTrips: SavedTrip[] = [];
  let searchQuery = tripDrawerSession.query;
  let sortOrder = tripDrawerSession.sort;
  let sourceFilter = tripDrawerSession.source;
  let statusFilter = tripDrawerSession.status;
  let loadState: 'loading' | 'ready' | 'unavailable' | 'error' = 'loading';
  let visibleIndices = new Set<number>();
  const head = el(`
    <div class="drawer-head">
      <div>
        <h2>Saved trips</h2>
        <p id="compare-selection-status" class="compare-selection-status" role="status" aria-live="polite">Select two trips to compare.</p>
      </div>
      <div class="drawer-head-actions">
        <button type="button" class="btn btn-ghost btn-compact" data-compare-selected aria-describedby="compare-selection-status" disabled>Compare selected (0/2)</button>
        <button type="button" class="btn btn-ghost btn-compact" data-close>Close</button>
      </div>
    </div>
  `);
  drawer.appendChild(head);
  head.querySelector('[data-close]')?.addEventListener('click', () => {
    hideTripsDrawer(drawer);
  });

  const controls = el(`
    <div class="trip-list-controls">
      <label class="trip-search-label" for="trip-search">Search saved trips</label>
      <input id="trip-search" class="trip-search" type="search" autocomplete="off" placeholder="Name, origin or destination" data-trip-search disabled>
      <button type="button" class="btn btn-compact btn-ghost" data-trip-search-clear disabled>Clear search</button>
      <label class="trip-sort-label" for="trip-sort">Sort</label>
      <select id="trip-sort" class="trip-sort" data-trip-sort disabled>
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="name">Name A–Z</option>
      </select>
      <label class="trip-sort-label" for="trip-source">Saved source</label>
      <select id="trip-source" class="trip-sort" data-trip-source disabled>
        <option value="all">All sources</option>
        <option value="live">Live</option>
        <option value="synthetic">Synthetic</option>
        <option value="unknown">Unknown</option>
      </select>
      <label class="trip-sort-label" for="trip-status">Saved plan status</label>
      <select id="trip-status" class="trip-sort" data-trip-status disabled>
        <option value="all">All statuses</option>
        <option value="ok">OK</option>
        <option value="degraded">Degraded</option>
        <option value="unknown">Unknown</option>
      </select>
      <button type="button" class="btn btn-compact btn-ghost" data-trip-filters-clear disabled>Clear all filters</button>
      <p class="trip-list-result-count" data-trip-result-count role="status" aria-live="polite"></p>
    </div>
  `);
  drawer.appendChild(controls);
  const list = el('<div class="trip-list"></div>');
  drawer.appendChild(list);
  const hiddenNotice = el('<p class="hint hidden-selection-notice" role="status" aria-live="polite" hidden></p>');
  drawer.appendChild(hiddenNotice);
  const status = head.querySelector<HTMLButtonElement>('[data-compare-selected]');
  const selectionStatus = head.querySelector<HTMLElement>('#compare-selection-status');
  const searchInput = controls.querySelector<HTMLInputElement>('[data-trip-search]');
  const clearSearch = controls.querySelector<HTMLButtonElement>('[data-trip-search-clear]');
  const sortSelect = controls.querySelector<HTMLSelectElement>('[data-trip-sort]');
  const sourceSelect = controls.querySelector<HTMLSelectElement>('[data-trip-source]');
  const statusSelect = controls.querySelector<HTMLSelectElement>('[data-trip-status]');
  const clearFilters = controls.querySelector<HTMLButtonElement>('[data-trip-filters-clear]');
  const resultCount = controls.querySelector<HTMLElement>('[data-trip-result-count]');
  if (searchInput) searchInput.value = searchQuery;
  if (sortSelect) sortSelect.value = sortOrder;
  if (sourceSelect) sourceSelect.value = sourceFilter;
  if (statusSelect) statusSelect.value = statusFilter;

  const updateHiddenSelectionNotice = (): void => {
    const hidden = [...selected].filter((index) => !visibleIndices.has(index)).length;
    hiddenNotice.hidden = hidden === 0;
    if (hidden > 0) {
      hiddenNotice.textContent = `${hidden} selected trip${hidden === 1 ? '' : 's'} hidden by the current filters.`;
    }
  };

  const renderList = (): void => {
    if (loadState !== 'ready') return;
    list.innerHTML = '';
    const entries = filterAndSortTrips(loadedTrips, searchQuery, sortOrder, { source: sourceFilter, status: statusFilter });
    if (resultCount) resultCount.textContent = `Showing ${entries.length} of ${loadedTrips.length} saved trips.`;
    if (searchInput) searchInput.disabled = false;
    if (sortSelect) sortSelect.disabled = false;
    if (sourceSelect) sourceSelect.disabled = false;
    if (statusSelect) statusSelect.disabled = false;
    if (clearSearch) clearSearch.disabled = searchQuery.length === 0;
    if (clearFilters) clearFilters.disabled = searchQuery.length === 0 && sourceFilter === 'all' && statusFilter === 'all';
    if (entries.length === 0) {
      const filtered = searchQuery.trim().length > 0 || sourceFilter !== 'all' || statusFilter !== 'all';
      list.appendChild(el(filtered
        ? '<p class="hint">No saved trips match the current filters.</p>'
        : '<p class="hint">No saved trips yet. Plan a route, then save it.</p>'));
    } else {
      entries.forEach(({ trip, sourceIndex }) => {
        list.appendChild(renderTripRow(trip, sourceIndex, selected.has(sourceIndex), toggleSelection, map, drawer, loadSavedRoute));
      });
    }
    visibleIndices = new Set(entries.map(({ sourceIndex }) => sourceIndex));
    updateSelection();
  };

  const updateSelection = (announcement?: string): void => {
    updateHiddenSelectionNotice();
    const count = selected.size;
    if (status) {
      status.textContent = `Compare selected (${count}/2)`;
      status.disabled = count !== 2;
    }
    if (selectionStatus) {
      selectionStatus.textContent = announcement ??
        (count === 2 ? 'Two trips selected. Compare them or remove one.' : `${count} of 2 trips selected.`);
    }
    list.querySelectorAll<HTMLButtonElement>('[data-compare-toggle]').forEach((button) => {
      const index = Number(button.dataset.compareIndex);
      const active = selected.has(index);
      button.setAttribute('aria-pressed', String(active));
      button.textContent = active ? 'Remove from comparison' : 'Select to compare';
    });
  };

  searchInput?.addEventListener('input', () => {
    searchQuery = searchInput.value;
    tripDrawerSession.query = searchQuery;
    renderList();
  });
  clearSearch?.addEventListener('click', () => {
    if (!searchInput) return;
    searchInput.value = '';
    searchQuery = '';
    tripDrawerSession.query = '';
    renderList();
    searchInput.focus({ preventScroll: true });
  });
  sortSelect?.addEventListener('change', () => {
    const value = sortSelect.value;
    sortOrder = value === 'oldest' || value === 'name' ? value : 'newest';
    tripDrawerSession.sort = sortOrder;
    renderList();
  });
  sourceSelect?.addEventListener('change', () => {
    sourceFilter = sourceFilterValue(sourceSelect.value);
    tripDrawerSession.source = sourceFilter;
    renderList();
  });
  statusSelect?.addEventListener('change', () => {
    statusFilter = statusFilterValue(statusSelect.value);
    tripDrawerSession.status = statusFilter;
    renderList();
  });
  clearFilters?.addEventListener('click', () => {
    searchQuery = '';
    sourceFilter = 'all';
    statusFilter = 'all';
    tripDrawerSession.query = '';
    tripDrawerSession.source = 'all';
    tripDrawerSession.status = 'all';
    if (searchInput) searchInput.value = '';
    if (sourceSelect) sourceSelect.value = 'all';
    if (statusSelect) statusSelect.value = 'all';
    renderList();
    searchInput?.focus({ preventScroll: true });
  });

  const toggleSelection = (index: number): void => {
    if (selected.has(index)) {
      selected.delete(index);
      updateSelection();
      return;
    }
    if (selected.size >= 2) {
      updateSelection('Two trips already selected. Remove one before selecting another.');
      return;
    }
    selected.add(index);
    updateSelection();
  };

  status?.addEventListener('click', () => {
    if (selected.size !== 2) return;
    const slots = [...selected].sort((a, b) => a - b);
    const panel = document.getElementById('planner-panel') as HTMLElement;
    const returnToDrawer = (): void => {
      clearTripComparisonView();
      drawer.classList.remove('hidden');
      const compare = head.querySelector<HTMLButtonElement>('[data-compare-selected]');
      const fallback = list.querySelector<HTMLButtonElement>('[data-compare-toggle]')
        ?? head.querySelector<HTMLButtonElement>('[data-close]');
      (compare && !compare.disabled ? compare : fallback)?.focus();
    };
    const drawComparison = (focusSwap = false): void => {
      const pair = slots.map((index) => loadedTrips[index] as SavedTrip);
      const comparison = buildTripComparison(pair);
      const root = renderTripComparisonWorkspace(panel, comparison, {
        onBack: returnToDrawer,
        onClear: () => {
          selected.clear();
          updateSelection('Comparison selection cleared.');
          returnToDrawer();
        },
        onSwap: () => {
          const first = slots[0] as number;
          slots[0] = slots[1] as number;
          slots[1] = first;
          drawComparison(true);
        },
        onRemove: (slot) => {
          selected.delete(slots[slot === 'A' ? 0 : 1] as number);
          updateSelection(`Removed route ${slot} from the comparison.`);
          returnToDrawer();
        },
        onOpen: (slot) => {
          clearTripComparisonView();
          openSavedTrip(pair[slot === 'A' ? 0 : 1] as SavedTrip, map, loadSavedRoute);
        },
        onEdit: (slot) => {
          clearTripComparisonView();
          if (loadSavedRoute(buildSavedRouteDraft(pair[slot === 'A' ? 0 : 1] as SavedTrip))) {
            hideTripsDrawer(drawer);
            toast('Saved route loaded for review — plan manually when ready.');
          }
        },
      });
      if (focusSwap) root.querySelector<HTMLElement>('[data-compare-swap]')?.focus();
      else root.focus();
    };
    drawer.classList.add('hidden');
    drawComparison();
  });

  const load = async (): Promise<void> => {
    list.innerHTML = '<p class="hint">Loading…</p>';
    try {
      const { trips } = await api.trips();
      list.innerHTML = '';
      const tripsKnown = Array.isArray(trips);
      loadedTrips = tripsKnown ? trips : [];
      selected.clear();
      if (!tripsKnown) {
        loadState = 'unavailable';
        if (searchInput) searchInput.disabled = true;
        if (sortSelect) sortSelect.disabled = true;
        if (sourceSelect) sourceSelect.disabled = true;
        if (statusSelect) statusSelect.disabled = true;
        if (clearFilters) clearFilters.disabled = true;
        if (resultCount) resultCount.textContent = 'Saved trip list is unavailable.';
        list.appendChild(el('<p class="hint">Saved trip list is unavailable.</p>'));
        updateSelection();
        return;
      }
      loadState = 'ready';
      renderList();
    } catch (err) {
      loadState = 'error';
      if (searchInput) searchInput.disabled = true;
      if (sortSelect) sortSelect.disabled = true;
      if (sourceSelect) sourceSelect.disabled = true;
      if (statusSelect) statusSelect.disabled = true;
      if (clearFilters) clearFilters.disabled = true;
      list.innerHTML = '';
      if (resultCount) resultCount.textContent = 'Saved trips could not be loaded.';
      list.appendChild(el(`<p class="hint">Could not load trips: ${escapeHtml(err instanceof Error ? err.message : 'unknown error')}</p>`));
    }
  };
  void load();
}

function renderTripRow(
  trip: SavedTrip,
  index: number,
  selected: boolean,
  onCompareToggle: (index: number) => void,
  map: maplibregl.Map,
  drawer: HTMLElement,
  loadSavedRoute: LoadSavedRoute,
): HTMLElement {
  const raw = record(trip) ?? {};
  const stationsKnown = Array.isArray(raw.stations);
  const stations = stationsKnown ? raw.stations as unknown[] : [];
  const countText = stationsKnown ? String(stations.length) : 'Unknown';
  const countLabel = stationsKnown ? `stop${stations.length === 1 ? '' : 's'}` : 'stops';
  const totals = record(raw.totals) ?? {} as SavedTrip['totals'];
  const row = el(`
    <div class="trip-row">
      <div class="trip-main">
        <span class="trip-name">${safeText(raw.name)}</span>
        <span class="trip-sub">
          ${safeText(record(raw.origin)?.label)} → ${safeText(record(raw.destination)?.label)}
          · ${safeInteger(raw.routeDistanceKm)} km
          · ${escapeHtml(countText)} ${escapeHtml(countLabel)}
          · ${escapeHtml(formatDuration(safeNumber(totals.totalTimeMin)))}
          ${raw.source === 'synthetic' ? '· <span class="synthetic-note">synthetic</span>' : raw.source !== 'live' ? '· <span class="unknown-note">source unknown</span>' : ''}
          ${raw.status === 'degraded' ? '· <span class="degraded-note">degraded</span>' : raw.status !== 'ok' ? '· <span class="unknown-note">status unknown</span>' : ''}
        </span>
      </div>
      <div class="trip-actions">
        <button type="button" class="btn btn-compact btn-ghost" data-compare-toggle data-compare-index="${index}" aria-pressed="${selected}">${selected ? 'Remove from comparison' : 'Select to compare'}</button>
        <button type="button" class="btn btn-compact btn-ghost" data-open>Open</button>
        <button type="button" class="btn btn-compact btn-ghost" data-return title="Load swapped endpoints as a new return-direction plan">Return trip</button>
        <button type="button" class="btn btn-compact btn-ghost" data-edit>Edit route</button>
        <button type="button" class="btn btn-compact btn-danger-ghost" data-delete>Delete</button>
      </div>
    </div>
  `);

  row.querySelector('[data-compare-toggle]')?.addEventListener('click', () => onCompareToggle(index));

  row.querySelector('[data-open]')?.addEventListener('click', () => {
    clearTripComparisonView();
    drawer.classList.add('hidden'); // hide directly: focus lands on the
    // trip summary below, not on the drawer's owner control
    openSavedTrip(trip, map, loadSavedRoute);
  });

  row.querySelector('[data-return]')?.addEventListener('click', () => {
    clearTripComparisonView();
    // Only the swapped endpoints and known vehicle facts enter the composer.
    // No reverse geometry, stops, totals, saved results or network call.
    if (!loadSavedRoute(buildReturnRouteDraft(trip))) return;
    hideTripsDrawer(drawer);
    toast('New return-direction plan loaded — review, then plan manually.');
  });

  row.querySelector('[data-edit]')?.addEventListener('click', () => {
    clearTripComparisonView();
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
  const mapTrip = savedMapTrip(trip);
  if (mapTrip) {
    drawTrip(map, mapTrip);
  } else if (map && typeof (map as unknown as Record<string, unknown>).getSource === 'function') {
    // Never leave an earlier live plan drawn under a saved-trip summary, and
    // never draw a filtered or reconstructed version of this saved route.
    clearTrip(map);
  }
  const panel = document.getElementById('planner-panel') as HTMLElement;
  renderSavedSummary(panel, trip, loadSavedRoute, mapTrip == null);
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
  mapOmitted: boolean,
): void {
  let results = panel.querySelector<HTMLElement>('.plan-results');
  if (!results) {
    results = el('<section class="plan-results" aria-label="Saved trip"></section>') as HTMLElement;
    panel.appendChild(results);
  }
  // The section may be REUSED from a live plan (no tabindex there): make
  // it programmatically focusable so openSavedTrip can land focus on it.
  results.setAttribute('tabindex', '-1');
  const raw = record(trip) ?? {};
  const stationsKnown = Array.isArray(raw.stations);
  const stations = stationsKnown ? raw.stations as unknown[] : [];
  const countText = stationsKnown ? String(stations.length) : 'Unknown';
  const countLabel = stationsKnown ? `stop${stations.length === 1 ? '' : 's'}` : 'stops';
  const totals = record(raw.totals) ?? {} as SavedTrip['totals'];
  const vehicle = record(raw.vehicle) ?? {} as SavedTrip['vehicle'];
  const origin = record(raw.origin) ?? {};
  const destination = record(raw.destination) ?? {};
  const createdAt = typeof raw.createdAt === 'string' && Number.isFinite(Date.parse(raw.createdAt))
    ? escapeHtml(new Date(raw.createdAt).toLocaleString('en-IN'))
    : 'Unknown';
  results.innerHTML = `
    <div class="banners">
      ${raw.source === 'synthetic' ? '<div class="banner banner-synthetic">Synthetic saved trip (mock data).</div>' : ''}
      ${raw.status === 'degraded' ? '<div class="banner banner-warn">This plan was saved with partial charger coverage (degraded).</div>' : ''}
      ${mapOmitted ? '<div class="banner banner-warn">Saved route geometry or stop coordinates were invalid or unavailable; no map route was drawn. The saved trip was not changed.</div>' : ''}
      ${stationsKnown ? '' : '<div class="banner banner-warn">Stored stop list is Unknown — this saved trip\'s itinerary is incomplete.</div>'}
      <div class="banner banner-soft">
        Saved on ${createdAt}.
        Charger status is never stored — station cards below fetch current
        details on request (labelled synthetic in mock mode).
      </div>
    </div>
    <div class="plan-head">
      <div class="plan-route">
        <span class="origin">${safeText(origin.label)}</span>
        <span class="arrow">→</span>
        <span class="destination">${safeText(destination.label)}</span>
      </div>
      <div class="plan-vehicle">
        ${safeText(vehicle.label)} · your real-world range ${safeNumber(vehicle.realWorldRangeKm) != null ? `${safeInteger(vehicle.realWorldRangeKm)} km` : 'Unknown'} · claim ${safeNumber(vehicle.claimedRangeKm) != null ? `${safeInteger(vehicle.claimedRangeKm)} km (mfr)` : 'Unknown'}
        ${typeof vehicle.realWorldRangeKm !== 'number' && vehicle.realWorldRangeKm != null ? `<span class="legacy-fact"> · legacy stored real-world text: ${safeText(String(vehicle.realWorldRangeKm))} (not a usable range)</span>` : ''}
        ${typeof vehicle.claimedRangeKm !== 'number' && vehicle.claimedRangeKm != null ? `<span class="legacy-fact"> · legacy stored claim text: ${safeText(String(vehicle.claimedRangeKm))} (not a usable claim)</span>` : ''}
      </div>
    </div>
    <div class="trip-strip">
      <div class="strip-cell"><span class="strip-num">${escapeHtml(formatDuration(safeNumber(totals.totalTimeMin)))}</span><span class="strip-label">Total time</span></div>
      <div class="strip-cell"><span class="strip-num">${safeInteger(raw.routeDistanceKm)}<span class="unit">km</span></span><span class="strip-label">Distance</span></div>
      <div class="strip-cell"><span class="strip-num">${escapeHtml(countText)}</span><span class="strip-label">${escapeHtml(countLabel)}</span></div>
      <div class="strip-cell"><span class="strip-num">${safeNumber(totals.estPriceInr) != null ? escapeHtml(`Rs. ${Math.round(safeNumber(totals.estPriceInr) as number).toLocaleString('en-IN')}`) : '—'}</span><span class="strip-label">Est. cost</span></div>
      <div class="strip-cell accent"><span class="strip-num">${safeSocText(totals.finalSocPct)}<span class="unit">%</span></span><span class="strip-label">Arrival charge</span></div>
      <div class="strip-cell"><span class="strip-num">${escapeHtml(formatDuration(safeNumber(totals.chargeTimeMin)))}</span><span class="strip-label">Charging time</span></div>
    </div>
    <div class="plan-actions saved-briefing-actions">
      <button type="button" class="btn btn-ghost" data-return-saved>Plan return trip</button>
      <button type="button" class="btn btn-ghost" data-edit-saved>Edit route</button>
      <button type="button" class="btn btn-ghost" data-itinerary-export>Journey itinerary (HTML)</button>
      <button type="button" class="btn btn-ghost" data-print>Print itinerary</button>
    </div>
    <div class="stops saved-stops">
      ${stations
        .map((station, i) => {
          const s = record(station) ?? {};
          const stationId = safeStationId(s.stationId);
          return `
        <article class="stop-card timeline saved-stop" data-station-id="${stationId != null ? escapeHtml(String(stationId)) : 'Unknown'}">
          <div class="stop-rail" aria-hidden="true">
            <span class="stop-node">${i + 1}</span>
            <span class="node-line"></span>
          </div>
          <div class="stop-main">
            <div class="stop-head">
              <div class="stop-title"><span class="stop-name">${safeText(s.name, 'Unknown station')}</span></div>
              <button type="button" class="btn btn-compact btn-ghost" data-revalidate${stationId == null ? ' disabled aria-label="Fetch unavailable — station id Unknown"' : ''}>Fetch current details</button>
            </div>
            <div class="stop-body">
              ${renderStationEvidencePanel({
                savedStation: s,
                plannedFacts: {
                  tariffPerKwh: s.pricePerKwh as number | null,
                  chargeKwh: s.chargeKwh as number | null,
                  chargeTimeMin: s.chargeTimeMin as number | null,
                  arriveSocPct: s.arriveSocPct as number | null,
                  leaveSocPct: s.leaveSocPct as number | null,
                },
              })}
            </div>
          </div>
        </article>`;
        })
        .join('')}
    </div>
  `;

  results.querySelector('[data-return-saved]')?.addEventListener('click', () => {
    if (loadSavedRoute(buildReturnRouteDraft(trip))) {
      toast('New return-direction plan loaded — review, then plan manually.');
    }
  });

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
    const stationId = safeStationId(record(stations[index])?.stationId);
    if (card && stationId != null) wireStationEvidence(card, {
      buttonSelector: '[data-revalidate]',
      stationId,
    });
  });
}
