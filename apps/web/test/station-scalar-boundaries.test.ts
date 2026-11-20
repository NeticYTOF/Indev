import { describe, expect, it } from 'vitest';
import { formatReviewCount, lastUsedLabel } from '../src/format.js';
import { stationDirectionsUrl, routeDirectionsUrl, routeDirectionsLinks } from '../src/safe-url.js';

describe('station scalar display boundaries', () => {
  it('preserves actual numeric zero and positive review counts', () => {
    expect(formatReviewCount(0)).toBe('0');
    expect(formatReviewCount(128)).toBe('128');
    expect(formatReviewCount(1234567)).toBe('12,34,567');
  });
  it.each([null, undefined, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '128', '<span data-proof>inert</span>', {}, []])('uses unknown rather than markup or an invented zero for %j', value => {
    expect(formatReviewCount(value)).toBe('unknown');
  });
  it('keeps malformed charger entries unknown instead of dereferencing them', () => {
    expect(lastUsedLabel([{ lastUsedOn: '18/11/2026' }])).toBe('18/11/2026');
    expect(lastUsedLabel(null)).toBe('unknown');
    expect(lastUsedLabel([null, undefined, 7, ' charger ', { lastUsedOn: 42 }])).toBe('unknown');
    expect(lastUsedLabel([null, { lastUsedOn: '02/11/2026' }])).toBe('2/11/2026');
  });
  it('preserves all waypoints or omits the whole route link without pruning', () => {
    const origin = { lat: 28, lon: 77 }, destination = { lat: 26, lon: 75 };
    expect(routeDirectionsUrl(origin, destination, [{ lat: 27, lon: 76 }, { lat: 26.5, lon: 75.5 }])).toBe('https://www.google.com/maps/dir/?api=1&origin=28,77&destination=26,75&waypoints=27%2C76%7C26.5%2C75.5');
    expect(routeDirectionsUrl(origin, destination, [{ lat: 27, lon: 76 }, { lat: 'bad', lon: 75.5 }])).toBeNull();
    expect(routeDirectionsUrl({ lat: 91, lon: 77 }, destination, [])).toBeNull();
  });
  it('keeps zero through 14 chargers in exact Maps order with mobile-safe chunks', () => {
    const origin = { lat: 28, lon: 77 }, destination = { lat: 26, lon: 75 };
    const allStops = Array.from({ length: 14 }, (_, index) => ({
      lat: 27 - index * 0.01, lon: 76 - index * 0.01,
    }));
    const coordinate = (point: { lat: number; lon: number }) => `${point.lat},${point.lon}`;
    for (const count of [0, 1, 3, 4, 8, 9, 14]) {
      const stops = allStops.slice(0, count);
      const links = routeDirectionsLinks(origin, destination, stops);
      expect(links).not.toBeNull();
      const flattened: string[] = [];
      for (const link of links ?? []) {
        const params = new URL(link.url).searchParams;
        const waypoints = (params.get('waypoints') ?? '').split('|').filter(Boolean);
        expect(waypoints.length).toBeLessThanOrEqual(3);
        expect(link.url.length).toBeLessThanOrEqual(1800);
        const segment = [params.get('origin') as string, ...waypoints, params.get('destination') as string];
        if (flattened.length > 0 && flattened.at(-1) === segment[0]) flattened.push(...segment.slice(1));
        else flattened.push(...segment);
      }
      expect(flattened).toEqual([origin, ...stops, destination].map(coordinate));
    }
    expect(routeDirectionsLinks(origin, destination, [
      { lat: 27, lon: 76 }, { lat: 'bad', lon: 75.9 },
    ])).toBeNull();
  });

  it('makes Directions links only from valid numeric coordinates, including zero and boundaries', () => {
    expect(stationDirectionsUrl(0, 0)).toBe('https://www.google.com/maps/dir/?api=1&destination=0%2C0');
    expect(stationDirectionsUrl(-90, 180)).toBe('https://www.google.com/maps/dir/?api=1&destination=-90%2C180');
  });
  it.each([['28', 77], [28, '77'], ['28" data-proof="inert', 77], [null, 77], [NaN, 77], [Infinity, 77], [91, 77], [28, 181], [-91, 77], [28, -181]])('refuses an unsupported coordinate pair: %j,%j', (lat, lon) => {
    expect(stationDirectionsUrl(lat, lon)).toBeNull();
  });
});
