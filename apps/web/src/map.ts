/**
 * Map layer: full-screen MapLibre map with the route polyline,
 * origin/destination pins and numbered charging-stop markers.
 * Flat colors only — no gradient fills anywhere.
 */
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const STYLE_FALLBACK_URL = 'https://tiles.openfreemap.org/styles/bright';

export interface MapStop {
  lat: number;
  lon: number;
  label: string;
  brand: string;
}

let tripLayerCounter = 0;

export function createMap(container: HTMLElement): maplibregl.Map {
  const map = new maplibregl.Map({
    container,
    style: STYLE_URL,
    center: [78.96, 22.59], // geographic centre of India
    zoom: 5, // z>=5 puts state and city labels in the visible tile ranges
    attributionControl: { compact: true },
    pitchWithRotate: false,
    dragRotate: false,
  });

  // Surface style/tile/glyph failures loudly: a silent failure renders
  // terrain with no labels (diagnosed during the visual pass). The console
  // output makes any future fetch failure self-evidencing.
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

  // If the primary style never loads, fall back to bright (still free,
  // still OpenFreeMap) so the UI never shows a label-less void.
  let styleLoaded = false;
  map.on('load', () => {
    styleLoaded = true;
  });
  setTimeout(() => {
    if (!styleLoaded) {
      console.warn('[map] style did not load in time; switching to fallback style');
      try {
        map.setStyle(STYLE_FALLBACK_URL);
      } catch {
        /* map already torn down */
      }
    }
  }, 15_000);

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

  // casing: white outline under the accent line (classic map clarity)
  map.addLayer({
    id: `${id}-casing`,
    type: 'line',
    source: id,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 10 },
  });
  map.addLayer({
    id: `${id}-line`,
    type: 'line',
    source: id,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color':
        getComputedStyle(document.documentElement).getPropertyValue('--route').trim() || '#2463eb',
      'line-width': 5,
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

  // fit with room for the left panel on desktop
  const wide = window.innerWidth > 720;
  const bounds = trip.geometry.reduce(
    (b, c) => b.extend(c as [number, number]),
    new maplibregl.LngLatBounds(trip.geometry[0] as [number, number], trip.geometry[0] as [number, number]),
  );
  map.fitBounds(bounds, {
    padding: {
      top: 90,
      bottom: 90,
      left: wide ? 460 : 40,
      right: wide ? 60 : 40,
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
