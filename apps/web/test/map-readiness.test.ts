import { describe, expect, it, vi } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';

// Exercise the actual queue/clear implementation without WebGL or network.
vi.mock('maplibre-gl', () => ({ setWorkerUrl: vi.fn() }));
import { clearTrip, drawTrip } from '../src/map.js';

function unreadyMap() {
  let ready = false;
  const listeners = new Map<string, Array<() => void>>();
  const addSource = vi.fn();
  const map = {
    isStyleLoaded: () => ready,
    on: (event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    getLayer: () => undefined,
    getSource: () => undefined,
    addSource,
  };
  return {
    map: map as unknown as MapLibreMap,
    addSource,
    makeReady: () => { ready = true; },
    emit: (event: string) => listeners.get(event)?.forEach((listener) => listener()),
  };
}

const trip = {
  geometry: [[77, 28], [76, 27]] as Array<[number, number]>,
  origin: { label: 'Fixture origin', lat: 28, lon: 77 },
  destination: { label: 'Fixture destination', lat: 27, lon: 76 },
  stops: [],
};

describe('deferred map drawings', () => {
  it('explicit clear cancels a queued trip on both readiness signals', () => {
    const state = unreadyMap();
    drawTrip(state.map, trip);
    expect(state.addSource).not.toHaveBeenCalled();
    clearTrip(state.map);
    state.makeReady();
    state.emit('style.load');
    state.emit('idle');
    expect(state.addSource).not.toHaveBeenCalled();
  });
});
