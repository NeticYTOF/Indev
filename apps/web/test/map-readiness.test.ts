import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';

const mapTestState = vi.hoisted(() => ({
  markers: [] as Array<{ element: { className: string; attributes: Record<string, string> }; removed: boolean }>,
}));

vi.mock('maplibre-gl', () => ({
  setWorkerUrl: vi.fn(),
  Marker: class {
    element: { className: string; attributes: Record<string, string> };
    removed = false;

    constructor(opts: { element: { className: string; attributes: Record<string, string> } }) {
      this.element = opts.element;
    }
    setLngLat() { return this; }
    addTo() { mapTestState.markers.push(this); return this; }
    remove() { this.removed = true; }
  },
  LngLatBounds: class {
    constructor(_a: unknown, _b: unknown) {}
    extend() { return this; }
  },
}));

import { clearTrip, drawTrip } from '../src/map.js';

class FakeElement {
  className = '';
  innerHTML = '';
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
}

function mapHarness() {
  let ready = false;
  const listeners = new Map<string, Array<() => void>>();
  const sources = new Map<string, unknown>();
  const layers = new Map<string, { id: string }>();
  const addSource = vi.fn((id: string, source: unknown) => { sources.set(id, source); });
  const addLayer = vi.fn((layer: { id: string }) => { layers.set(layer.id, layer); });
  const fitBounds = vi.fn();
  const map = {
    isStyleLoaded: () => ready,
    on: (event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    getLayer: (id: string) => layers.get(id),
    getSource: (id: string) => sources.get(id),
    addSource,
    addLayer,
    removeLayer: (id: string) => { layers.delete(id); },
    removeSource: (id: string) => { sources.delete(id); },
    fitBounds,
  };
  return {
    map: map as unknown as MapLibreMap,
    sources,
    layers,
    addSource,
    addLayer,
    fitBounds,
    makeReady: () => { ready = true; },
    emit: (event: string) => listeners.get(event)?.forEach((listener) => listener()),
    reloadStyle: () => { ready = false; sources.clear(); layers.clear(); },
    finishReload: () => { ready = true; listeners.get('style.load')?.forEach((listener) => listener()); },
  };
}

const trip = {
  geometry: [[77, 28], [76, 27]] as Array<[number, number]>,
  origin: { label: 'Fixture origin', lat: 28, lon: 77 },
  destination: { label: 'Fixture destination', lat: 27, lon: 76 },
  stops: [],
};

function layerKinds(state: ReturnType<typeof mapHarness>): string[] {
  return [...state.layers.keys()].map((id) => id.split('-').at(-1) ?? '');
}

beforeEach(() => {
  mapTestState.markers.length = 0;
  vi.stubGlobal('window', { innerWidth: 1280 });
  vi.stubGlobal('document', { createElement: () => new FakeElement() });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deferred map drawings', () => {
  it('explicit clear cancels a queued trip on both readiness signals', () => {
    const state = mapHarness();
    drawTrip(state.map, trip);
    expect(state.addSource).not.toHaveBeenCalled();
    clearTrip(state.map);
    state.makeReady();
    state.emit('style.load');
    state.emit('idle');
    expect(state.addSource).not.toHaveBeenCalled();
    expect(mapTestState.markers).toHaveLength(0);
  });

  it('redraws only the latest queued route once when style becomes ready', () => {
    const state = mapHarness();
    const later = { ...trip, origin: { label: 'Later origin', lat: 28, lon: 77 } };
    drawTrip(state.map, trip);
    drawTrip(state.map, later);
    state.makeReady();
    state.emit('style.load');
    state.emit('idle');
    expect(layerKinds(state).sort()).toEqual(['casing', 'line']);
    expect(state.sources.size).toBe(1);
    const source = [...state.sources.values()][0] as { data: { geometry: { coordinates: Array<[number, number]> } } };
    expect(source.data.geometry.coordinates).toBe(later.geometry);
    expect(mapTestState.markers).toHaveLength(2);
    expect(mapTestState.markers[0]?.element.attributes['aria-label']).toBe('A: Later origin');
    expect(state.fitBounds).toHaveBeenCalledTimes(1);
  });

  it('restores route vector layers after a style reload without new markers or camera moves', () => {
    const state = mapHarness();
    state.makeReady();
    drawTrip(state.map, trip);
    expect(layerKinds(state).sort()).toEqual(['casing', 'line']);
    expect(mapTestState.markers).toHaveLength(2);
    const markerElements = mapTestState.markers.map((m) => m.element);
    expect(state.fitBounds).toHaveBeenCalledTimes(1);

    state.reloadStyle();
    expect(state.sources.size).toBe(0);
    expect(state.layers.size).toBe(0);
    expect(mapTestState.markers).toHaveLength(2);

    state.finishReload();
    expect(layerKinds(state).sort()).toEqual(['casing', 'line']);
    expect(state.sources.size).toBe(1);
    expect(mapTestState.markers.map((m) => m.element)).toEqual(markerElements);
    expect(state.fitBounds).toHaveBeenCalledTimes(1);

    state.emit('style.load');
    state.emit('idle');
    expect(layerKinds(state).sort()).toEqual(['casing', 'line']);
    expect(state.addLayer).toHaveBeenCalledTimes(4); // initial pair + one restored pair
    expect(state.fitBounds).toHaveBeenCalledTimes(1);
  });

  it('does not restore cleared routes on later style readiness', () => {
    const state = mapHarness();
    state.makeReady();
    drawTrip(state.map, trip);
    state.reloadStyle();
    clearTrip(state.map);
    expect(mapTestState.markers.every((m) => m.removed)).toBe(true);
    state.finishReload();
    state.emit('idle');
    expect(state.sources.size).toBe(0);
    expect(state.layers.size).toBe(0);
  });
});
