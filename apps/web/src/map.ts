/**
 * Map layer: full-screen MapLibre map with the route polyline,
 * origin/destination pins and numbered charging-stop markers.
 * Milestone: the basemap is pushed to true black with quiet grey roads;
 * the route is a solid highway-yellow line that draws itself from A to B,
 * and stops/endpoints are kilometre-stone markers.
 */
import * as maplibregl from 'maplibre-gl';
import { cumulativeKm, formatLegKm, pointAtDistance } from './leg-distance.js';
import { closeStopSheet } from './stop-sheet.js';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre builds its web worker from a URL derived from import.meta.url;
// bundlers can't follow that (dev serves it 504, build emits nothing -> 404
// and the map renders black). Hand the library an explicit asset URL that
// Vite statically emits: `?url` copies the pre-bundled, self-contained
// worker file into the build and serves the exact file in dev.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

// Must run before the first Map claims the worker pool.
maplibregl.setWorkerUrl(maplibreWorkerUrl);

/** Dark styles, tried in order (all free, no API keys). */
const STYLE_URLS = [
  'https://tiles.openfreemap.org/styles/dark',
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  'https://tiles.openfreemap.org/styles/liberty',
];

// Last-resort route colors when CSS custom props are unavailable (e.g. in
// a non-browser test environment).
const FALLBACK_ROUTE = '#FFC72C';
const FALLBACK_CASING = '#000000';

export interface MapStop {
  lat: number;
  lon: number;
  label: string;
  brand: string;
}

let tripLayerCounter = 0;

function cssToken(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function createMap(container: HTMLElement): maplibregl.Map {
  const map = new maplibregl.Map({
    container,
    style: STYLE_URLS[0] as string,
    center: [78.96, 22.59], // geographic centre of India
    zoom: 5, // z>=5 puts state and city labels in the visible tile ranges
    attributionControl: { compact: true },
    pitchWithRotate: false,
    dragRotate: false,
  });

  // Surface style/tile/glyph failures loudly: a silent failure renders
  // terrain with no labels. The console output makes any future fetch
  // failure self-evidencing.
  map.on('error', (e) => {
    const err = e as { error?: unknown; sourceId?: string; layerId?: string; sourceLayerId?: string; tile?: unknown };
    console.warn(
      '[map]',
      JSON.stringify({
        message: err.error instanceof Error ? err.error.message : String(err.error ?? 'unknown'),
        source: err.sourceId,
        layer: err.layerId,
        sourceLayer: err.sourceLayerId,
        hasTile: Boolean(err.tile),
      }),
    );
  });

  // Style fallback chain: if a style never loads, walk to the next one so
  // the UI never shows a label-less void. Attempts are bounded by the list.
  let styleIndex = 0;
  let loadTimer: ReturnType<typeof setTimeout> | null = null;
  const armFallback = (): void => {
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
      styleIndex += 1;
      const next = STYLE_URLS[styleIndex];
      if (!next) return;
      console.warn(`[map] style did not load in time; switching to fallback ${styleIndex}`);
      try {
        map.setStyle(next);
      } catch {
        return;
      }
      armFallback();
    }, 15_000);
  };
  map.on('load', () => {
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = null;
  });
  armFallback();
  // Every style (including fallbacks) is re-tinted to the AMOLED palette.
  map.on('style.load', () => darkenBasemap(map));

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');
  map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'bottom-left');
  return map;
}

interface TripDraw {
  geometry: Array<[number, number]>; // [lon, lat]
  origin: { lat: number; lon: number; label: string };
  destination: { lat: number; lon: number; label: string };
  stops: MapStop[];
}

/** One drivable leg for the on-map distance pill (plan chainage, km). */
export interface MapLeg {
  km: number | null;
  startChainageKm: number | null;
  endChainageKm: number | null;
}

export interface DrawTripOptions {
  /** Makes stop markers buttons that open the stop's charger details. */
  onStopClick?: (index: number) => void;
  /** Leg distances shown as pills along the route. */
  legs?: readonly MapLeg[];
  /** Plan chainage total, used to place pills on the drawn geometry. */
  totalKm?: number | null;
}

const tripOptions = new WeakMap<maplibregl.Map, DrawTripOptions>();
const legPills = new WeakMap<maplibregl.Map, { markers: maplibregl.Marker[]; onZoom: () => void }>();

const tripSources = new WeakMap<maplibregl.Map, maplibregl.Marker[]>();
// A plan may finish before the basemap. Keep only the latest requested
// drawing; the route summary must not fail because a style is offline.
const pendingTrips = new WeakMap<maplibregl.Map, TripDraw>();
const readinessListeners = new WeakSet<maplibregl.Map>();

interface ActiveRouteSource {
  id: string;
  geometry: Array<[number, number]>;
}

// setStyle removes style-owned sources/layers but leaves DOM markers alone.
// Remember the active route so a style reload can reinstall ONLY the route
// vector layers; markers and the user's camera must remain untouched.
const activeRoutes = new WeakMap<maplibregl.Map, ActiveRouteSource>();
const styleRecoveryListeners = new WeakSet<maplibregl.Map>();

function addRouteLayers(
  map: maplibregl.Map,
  id: string,
  geometry: Array<[number, number]>,
): void {
  if (!map.getSource(id)) {
    map.addSource(id, {
      type: 'geojson',
      // line-progress (used for the draw-in) needs line metrics.
      lineMetrics: true,
      data: {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: geometry },
      },
    });
  }
  if (!map.getLayer(`${id}-casing`)) {
    // A black casing separates the route from roads beneath it.
    map.addLayer({
      id: `${id}-casing`,
      type: 'line',
      source: id,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': cssToken('--route-casing', FALLBACK_CASING),
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 8, 10, 12],
      },
    });
  }
  if (!map.getLayer(`${id}-line`)) {
    map.addLayer({
      id: `${id}-line`,
      type: 'line',
      source: id,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': cssToken('--route', FALLBACK_ROUTE),
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 3.5, 10, 6],
        'line-gradient': routeReveal(1) as never,
      },
    });
  }
}

/* ------------------------------------------------------------------ */
/* Route draw-in: the line extends from A to B once per plan            */
/* ------------------------------------------------------------------ */

const DRAW_MS = 1400;
const routeAnimations = new WeakMap<maplibregl.Map, { id: string; raf: number }>();

/**
 * Solid route colour up to `drawn` (0..1) along the line, nothing beyond.
 * Two adjacent stops make a hard edge, so the visible line is one colour.
 */
function routeReveal(drawn: number): unknown[] {
  const color = cssToken('--route', FALLBACK_ROUTE);
  if (drawn >= 1) return ['interpolate', ['linear'], ['line-progress'], 0, color, 1, color];
  const edge = Math.max(0.002, Math.min(0.998, drawn));
  const clear = 'rgba(0,0,0,0)';
  return ['interpolate', ['linear'], ['line-progress'], 0, color, edge, color, edge + 0.001, clear, 1, clear];
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function stopRouteAnimation(map: maplibregl.Map): void {
  const running = routeAnimations.get(map);
  if (running && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(running.raf);
  routeAnimations.delete(map);
}

function animateRoute(map: maplibregl.Map, id: string): void {
  stopRouteAnimation(map);
  const canPaint = typeof (map as unknown as { setPaintProperty?: unknown }).setPaintProperty === 'function';
  if (!canPaint || typeof requestAnimationFrame !== 'function' || reducedMotion()) return;
  const layer = `${id}-line`;
  const started = performance.now();
  const state = { id, raf: 0 };
  const step = (now: number): void => {
    if (routeAnimations.get(map) !== state || !map.getLayer(layer)) return;
    const t = Math.min(1, (now - started) / DRAW_MS);
    try {
      map.setPaintProperty(layer, 'line-gradient', routeReveal(easeInOut(t)) as never);
    } catch {
      stopRouteAnimation(map);
      return;
    }
    if (t < 1) state.raf = requestAnimationFrame(step);
    else {
      routeAnimations.delete(map);
      startRouteLife(map, id);
    }
  };
  routeAnimations.set(map, state);
  state.raf = requestAnimationFrame(step);
}

function easeInOut(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/* ------------------------------------------------------------------ */
/* Basemap: push any dark style to true black                           */
/* ------------------------------------------------------------------ */

function darkenBasemap(map: maplibregl.Map): void {
  let layers: Array<{ id: string; type: string }> = [];
  try {
    layers = (map.getStyle()?.layers ?? []) as Array<{ id: string; type: string }>;
  } catch {
    return;
  }
  const set = (id: string, prop: string, value: unknown): void => {
    try {
      map.setPaintProperty(id, prop as never, value as never);
    } catch {
      // A style may not support a property on this layer; skip it.
    }
  };
  for (const layer of layers) {
    const id = layer.id.toLowerCase();
    if (id.startsWith('trip-')) continue;
    if (layer.type === 'background') {
      set(layer.id, 'background-color', '#000000');
    } else if (layer.type === 'fill') {
      if (/water|ocean|sea|lake|river/.test(id)) set(layer.id, 'fill-color', '#0a0d10');
      else if (/building/.test(id)) set(layer.id, 'fill-color', '#0e0e0e');
      else set(layer.id, 'fill-color', '#000000');
      set(layer.id, 'fill-outline-color', 'rgba(0,0,0,0)');
    } else if (layer.type === 'fill-extrusion') {
      set(layer.id, 'fill-extrusion-color', '#0e0e0e');
    } else if (layer.type === 'line') {
      if (/water|river|stream|canal/.test(id)) set(layer.id, 'line-color', '#141a20');
      else if (/boundary|admin|border/.test(id)) set(layer.id, 'line-color', '#333333');
      else if (/casing|outline/.test(id)) set(layer.id, 'line-color', '#000000');
      else if (/motorway|trunk/.test(id)) set(layer.id, 'line-color', '#3a3a3a');
      else if (/primary|secondary/.test(id)) set(layer.id, 'line-color', '#262626');
      else if (/road|street|highway|tertiary|minor|service|path|track|bridge|tunnel|rail|transportation/.test(id)) set(layer.id, 'line-color', '#181818');
    } else if (layer.type === 'symbol') {
      set(layer.id, 'text-color', /place|city|town|capital|state|country/.test(id) ? '#a6a6a1' : '#6e6e69');
      set(layer.id, 'text-halo-color', '#000000');
      set(layer.id, 'text-halo-width', 1.2);
      set(layer.id, 'icon-opacity', 0.3);
    }
  }
}

function restoreActiveRoute(map: maplibregl.Map): void {
  const active = activeRoutes.get(map);
  if (!active) return;
  addRouteLayers(map, active.id, active.geometry);
  animateRoute(map, active.id);
}

function installStyleRecovery(map: maplibregl.Map): void {
  if (styleRecoveryListeners.has(map)) return;
  styleRecoveryListeners.add(map);
  map.on('style.load', () => restoreActiveRoute(map));
}

function flushPendingTrip(map: maplibregl.Map): void {
  const trip = pendingTrips.get(map);
  if (!trip || !map.isStyleLoaded()) return;
  pendingTrips.delete(map);
  drawTrip(map, trip, tripOptions.get(map));
}

export function drawTrip(map: maplibregl.Map, trip: TripDraw, options: DrawTripOptions = {}): void {
  if (!map.isStyleLoaded()) {
    pendingTrips.set(map, trip);
    tripOptions.set(map, options);
    if (!readinessListeners.has(map)) {
      readinessListeners.add(map);
      // style.load handles the initial style or its fallback; idle covers
      // styles whose sources are still loading at style.load time.
      map.on('style.load', () => flushPendingTrip(map));
      map.on('idle', () => flushPendingTrip(map));
    }
    return;
  }
  pendingTrips.delete(map);
  clearTrip(map);
  tripOptions.set(map, options);
  const id = `trip-${++tripLayerCounter}`;
  // The route: a black casing under a solid yellow line that draws in.
  addRouteLayers(map, id, trip.geometry);
  activeRoutes.set(map, { id, geometry: trip.geometry.slice() });
  installStyleRecovery(map);
  animateRoute(map, id);

  const markers: maplibregl.Marker[] = [];
  tripSources.set(map, markers);
  (map as unknown as Record<string, unknown>)['__indeev_trip_id'] = id;

  // Markers land in route order, roughly as the current draws past them.
  const stopSpacing = trip.stops.length > 0 ? (DRAW_MS - 400) / (trip.stops.length + 1) : 0;
  markers.push(makePin(map, trip.origin, 'A', 'origin', 150));
  trip.stops.forEach((s, i) => {
    const onClick = options.onStopClick ? () => options.onStopClick?.(i) : undefined;
    markers.push(makeStop(map, s, i + 1, onClick, 300 + (i + 1) * stopSpacing));
  });
  markers.push(makePin(map, trip.destination, 'B', 'destination', DRAW_MS - 150));
  if (options.legs && options.legs.length > 0) addLegPills(map, trip.geometry, options.legs, options.totalKm ?? null);

  // Frame the route with room for the floating panels. On mobile the bottom
  // sheet will cover the lower half, so the route sits in the upper area.
  const wide = window.innerWidth > 720;
  const bounds = trip.geometry.reduce(
    (b, c) => b.extend(c as [number, number]),
    new maplibregl.LngLatBounds(trip.geometry[0] as [number, number], trip.geometry[0] as [number, number]),
  );
  map.fitBounds(bounds, {
    padding: {
      top: 84,
      bottom: wide ? 84 : 340,
      left: wide ? 478 : 36,
      right: wide ? 64 : 36,
    },
    duration: 1400,
    maxZoom: 13,
  });
}

export function clearTrip(map: maplibregl.Map): void {
  // Details of a stop that is no longer drawn must never stay on screen.
  closeStopSheet({ restoreFocus: false });
  stopRouteAnimation(map);
  stopRouteLife(map);
  pendingTrips.delete(map);
  activeRoutes.delete(map);
  tripOptions.delete(map);
  removeLegPills(map);
  const markers = tripSources.get(map);
  if (markers) {
    markers.forEach((m) => m.remove());
    tripSources.delete(map);
  }
  const id = (map as unknown as Record<string, unknown>)['__indeev_trip_id'] as string | undefined;
  if (id && map.getLayer(`${id}-flow`)) map.removeLayer(`${id}-flow`);
  if (id && map.getLayer(`${id}-line`)) map.removeLayer(`${id}-line`);
  if (id && map.getLayer(`${id}-casing`)) map.removeLayer(`${id}-casing`);
  if (id && map.getSource(id)) map.removeSource(id);
  delete (map as unknown as Record<string, unknown>)['__indeev_trip_id'];
}

function makePin(
  map: maplibregl.Map,
  at: { lat: number; lon: number; label: string },
  letter: 'A' | 'B',
  kind: 'origin' | 'destination',
  delayMs = 0,
): maplibregl.Marker {
  const el = document.createElement('div');
  el.className = `pin pin-${kind}`;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', `${letter}: ${at.label}`);
  el.style.setProperty?.('--delay', `${Math.round(delayMs)}ms`);
  // A beacon: orb + light stem + ground ring at the exact coordinate.
  el.innerHTML = `<span class="pin-orb">${letter}</span><span class="pin-stem"></span><span class="pin-ground"></span>`;
  const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
    .setLngLat([at.lon, at.lat])
    .addTo(map);
  return marker;
}

export function makeStop(
  map: maplibregl.Map,
  stop: MapStop,
  number: number,
  onClick?: () => void,
  delayMs = 0,
): maplibregl.Marker {
  // exposed separately so saved-trip views can add interactive markers
  const el = document.createElement('div');
  el.className = 'stop-marker';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', `Charging stop ${number}: ${stop.label} (${stop.brand})`);
  el.style.setProperty?.('--delay', `${Math.round(delayMs)}ms`);
  // A charge node: orbit ring + ping + numbered core (all decorative).
  el.innerHTML = `<span class="stop-marker-orbit"></span><span class="stop-marker-ping"></span><span class="stop-marker-core"><span class="stop-num">${number}</span></span>`;
  el.dataset.stopIndex = String(number - 1);
  if (onClick) {
    // A real control: focusable, named for what it does, keyboard-operable.
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.classList.add('is-interactive');
    el.setAttribute('aria-label', `Charging stop ${number}: ${stop.label} (${stop.brand}) — show charger details`);
    el.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); }
    });
    el.style.cursor = 'pointer';
  }
  return new maplibregl.Marker({ element: el, anchor: 'center' })
    .setLngLat([stop.lon, stop.lat])
    .addTo(map);
}

/* ------------------------------------------------------------------ */
/* Route life: once drawn, traffic flows along the line and a tiny EV  */
/* drives A -> B on a loop. Decorative only (aria-hidden marker).       */
/* ------------------------------------------------------------------ */

interface RouteLife { raf: number; car: maplibregl.Marker | null; }
const routeLives = new WeakMap<maplibregl.Map, RouteLife>();

function stopRouteLife(map: maplibregl.Map): void {
  const life = routeLives.get(map);
  if (!life) return;
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(life.raf);
  life.car?.remove();
  routeLives.delete(map);
}

const DASH_SEQUENCE: number[][] = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5],
  [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2],
  [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
];

function startRouteLife(map: maplibregl.Map, id: string): void {
  stopRouteLife(map);
  const m = map as unknown as {
    setPaintProperty?: unknown; addLayer?: unknown; getLayer?: (id: string) => unknown;
  };
  if (reducedMotion() || typeof m.setPaintProperty !== 'function' || typeof requestAnimationFrame !== 'function') return;
  const active = activeRoutes.get(map);
  if (!active || active.id !== id || active.geometry.length < 2) return;
  try {
    if (!map.getLayer(`${id}-flow`)) {
      map.addLayer({
        id: `${id}-flow`,
        type: 'line',
        source: id,
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          'line-color': '#000000',
          'line-opacity': 0.55,
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.6, 10, 2.6],
          'line-dasharray': [0, 4, 3],
        },
      });
    }
  } catch {
    return;
  }
  // Pre-compute cumulative distances for constant-speed travel.
  const geom = active.geometry;
  const cum: number[] = [0];
  for (let i = 1; i < geom.length; i += 1) {
    const a = geom[i - 1] as [number, number];
    const b = geom[i] as [number, number];
    cum.push((cum[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[cum.length - 1] as number;
  let car: maplibregl.Marker | null = null;
  if (total > 0 && typeof document !== 'undefined') {
    const el = document.createElement('div');
    el.className = 'route-car';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div class="route-car-inner"><svg viewBox="0 0 40 22" aria-hidden="true"><path class="car-body" d="M4 14c0-3 1-5 4-6l5-5c1-1 2-1 3-1h9c2 0 3 1 4 2l4 4c3 0 5 2 5 5v2c0 1-1 2-2 2H6c-1 0-2-1-2-2z"/><path class="car-glass" d="M14 4h6v5h-10zM22 4h3c1 0 2 1 3 2l2 3h-8z"/><circle class="car-wheel" cx="11" cy="17" r="3.4"/><circle class="car-wheel" cx="30" cy="17" r="3.4"/><path class="car-bolt" d="M21 10l-3 4h2l-1 3 3-4h-2z"/></svg></div>';
    try {
      car = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(geom[0] as [number, number]).addTo(map);
    } catch {
      car = null;
    }
  }
  const inner = car?.getElement?.().querySelector<HTMLElement>('.route-car-inner') ?? null;
  const life: RouteLife = { raf: 0, car };
  routeLives.set(map, life);
  const LOOP_MS = Math.min(16000, Math.max(7000, geom.length * 6));
  const started = performance.now();
  let lastDash = -1;
  let seg = 1;
  const frame = (now: number): void => {
    if (routeLives.get(map) !== life || !map.getLayer(`${id}-flow`)) return;
    const dashStep = Math.floor(now / 70) % DASH_SEQUENCE.length;
    if (dashStep !== lastDash) {
      lastDash = dashStep;
      try { map.setPaintProperty(`${id}-flow`, 'line-dasharray', DASH_SEQUENCE[dashStep] as never); } catch { /* style swap */ }
    }
    if (car && total > 0) {
      const p = ((now - started) % LOOP_MS) / LOOP_MS;
      const d = easeInOut(p) * total;
      if (d < (cum[seg - 1] as number)) seg = 1;
      while (seg < cum.length - 1 && (cum[seg] as number) < d) seg += 1;
      const a = geom[seg - 1] as [number, number];
      const b = geom[seg] as [number, number];
      const span = (cum[seg] as number) - (cum[seg - 1] as number) || 1;
      const f = (d - (cum[seg - 1] as number)) / span;
      car.setLngLat([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      if (inner) {
        const pa = map.project(a);
        const pb = map.project(b);
        const deg = Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180 / Math.PI;
        // Keep the car upright: mirror instead of driving upside-down.
        const flip = deg > 90 || deg < -90;
        inner.style.transform = flip ? `rotate(${deg + 180}deg) scaleX(-1)` : `rotate(${deg}deg)`;
      }
    }
    life.raf = requestAnimationFrame(frame);
  };
  life.raf = requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ */
/* Stop focus + leg distance pills                                      */
/* ------------------------------------------------------------------ */

/** Highlight one stop marker (or none). */
export function setActiveStop(map: maplibregl.Map, index: number | null): void {
  for (const marker of tripSources.get(map) ?? []) {
    const el = marker.getElement();
    if (!el.classList.contains('stop-marker')) continue;
    const active = index != null && el.dataset.stopIndex === String(index);
    el.classList.toggle('is-active', active);
    if (el.getAttribute('role') === 'button') el.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

/** Pan so a stop sits clear of the floating panels, keeping the zoom. */
export function revealStop(map: maplibregl.Map, lngLat: [number, number]): void {
  const wide = window.innerWidth > 720;
  try {
    map.easeTo({ center: lngLat, offset: wide ? [-120, 0] : [0, -140], duration: reducedMotion() ? 0 : 700 });
  } catch { /* map not ready: the sheet still opens */ }
}

function removeLegPills(map: maplibregl.Map): void {
  const pills = legPills.get(map);
  if (!pills) return;
  pills.markers.forEach((m) => m.remove());
  map.off('zoomend', pills.onZoom);
  map.off('moveend', pills.onZoom);
  legPills.delete(map);
}

function addLegPills(
  map: maplibregl.Map,
  geometry: Array<[number, number]>,
  legs: readonly MapLeg[],
  totalKm: number | null,
): void {
  removeLegPills(map);
  const cumulative = cumulativeKm(geometry);
  const markers: maplibregl.Marker[] = [];
  legs.forEach((leg, i) => {
    if (leg.km == null || leg.startChainageKm == null || leg.endChainageKm == null) return;
    const at = pointAtDistance(geometry, (leg.startChainageKm + leg.endChainageKm) / 2, totalKm, cumulative);
    if (!at) return;
    const el = document.createElement('div');
    el.className = 'leg-pill';
    el.setAttribute('aria-hidden', 'true');
    el.style.setProperty('--delay', `${Math.round(DRAW_MS + 120 + i * 110)}ms`);
    const dot = document.createElement('span');
    dot.className = 'leg-pill-dot';
    const km = document.createElement('span');
    km.className = 'leg-pill-km';
    km.textContent = formatLegKm(leg.km);
    el.append(dot, km);
    markers.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(at).addTo(map));
  });
  // Declutter: hide pills that would collide with a neighbour at this zoom.
  const onZoom = (): void => {
    const shown: Array<{ x: number; y: number }> = [];
    for (const marker of markers) {
      const p = map.project(marker.getLngLat());
      const crowded = map.getZoom() < 4.5 || shown.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 64);
      marker.getElement().classList.toggle('is-crowded', crowded);
      if (!crowded) shown.push({ x: p.x, y: p.y });
    }
  };
  map.on('zoomend', onZoom);
  map.on('moveend', onZoom);
  legPills.set(map, { markers, onZoom });
  onZoom();
}
