/**
 * Map layer: full-screen MapLibre map with the route polyline,
 * origin/destination pins and numbered charging-stop markers.
 * Night Drive: dark basemap as the hero; flat colors only.
 */
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

/** Dark styles, tried in order (all free, no API keys). */
const STYLE_URLS = [
  'https://tiles.openfreemap.org/styles/dark',
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  'https://tiles.openfreemap.org/styles/liberty',
];

// Last-resort route colors when CSS custom props are unavailable (e.g. in
// a non-browser test environment).
const FALLBACK_ROUTE = '#4D9FFF';
const FALLBACK_CASING = '#E9F1FC';

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

const tripSources = new WeakMap<maplibregl.Map, maplibregl.Marker[]>();

export function drawTrip(map: maplibregl.Map, trip: TripDraw): void {
  clearTrip(map);
  const id = `trip-${++tripLayerCounter}`;

  map.addSource(id, {
    type: 'geojson',
    data: {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: trip.geometry,
      },
    },
  });

  // Dark-map route: a light casing under the accent line for crisp clarity.
  map.addLayer({
    id: `${id}-casing`,
    type: 'line',
    source: id,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': cssToken('--route-casing', FALLBACK_CASING),
      'line-width': 9,
    },
  });
  map.addLayer({
    id: `${id}-line`,
    type: 'line',
    source: id,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': cssToken('--route', FALLBACK_ROUTE),
      'line-width': 4.5,
    },
  });

  const markers: maplibregl.Marker[] = [];
  tripSources.set(map, markers);
  (map as unknown as Record<string, unknown>)['__indeev_trip_id'] = id;

  markers.push(makePin(map, trip.origin, 'A', 'origin'));
  trip.stops.forEach((s, i) => {
    markers.push(makeStop(map, s, i + 1));
  });
  markers.push(makePin(map, trip.destination, 'B', 'destination'));

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
    duration: 800,
    maxZoom: 13,
  });
}

export function clearTrip(map: maplibregl.Map): void {
  const markers = tripSources.get(map);
  if (markers) {
    markers.forEach((m) => m.remove());
    tripSources.delete(map);
  }
  const id = (map as unknown as Record<string, unknown>)['__indeev_trip_id'] as string | undefined;
  if (id && map.getLayer(`${id}-line`)) map.removeLayer(`${id}-line`);
  if (id && map.getLayer(`${id}-casing`)) map.removeLayer(`${id}-casing`);
  if (id && map.getSource(id)) map.removeSource(id);
}

function makePin(
  map: maplibregl.Map,
  at: { lat: number; lon: number; label: string },
  letter: 'A' | 'B',
  kind: 'origin' | 'destination',
): maplibregl.Marker {
  const el = document.createElement('div');
  el.className = `pin pin-${kind}`;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', `${letter}: ${at.label}`);
  el.innerHTML = `<span>${letter}</span>`;
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
): maplibregl.Marker {
  // exposed separately so saved-trip views can add interactive markers
  const el = document.createElement('div');
  el.className = 'stop-marker';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', `Charging stop ${number}: ${stop.label} (${stop.brand})`);
  el.innerHTML = `<span class="stop-num">${number}</span>`;
  if (onClick) {
    el.addEventListener('click', onClick);
    el.style.cursor = 'pointer';
  }
  return new maplibregl.Marker({ element: el, anchor: 'center' })
    .setLngLat([stop.lon, stop.lat])
    .addTo(map);
}
