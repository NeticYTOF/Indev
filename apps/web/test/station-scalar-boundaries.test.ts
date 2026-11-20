import { describe, expect, it } from 'vitest';
import { formatReviewCount } from '../src/format.js';
import { stationDirectionsUrl, routeDirectionsUrl } from '../src/safe-url.js';

describe('station scalar display boundaries', () => {
  it('preserves actual numeric zero and positive review counts', () => {
    expect(formatReviewCount(0)).toBe('0');
    expect(formatReviewCount(128)).toBe('128');
    expect(formatReviewCount(1234567)).toBe('12,34,567');
  });
  it.each([null, undefined, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '128', '<span data-proof>inert</span>', {}, []])('uses unknown rather than markup or an invented zero for %j', value => {
    expect(formatReviewCount(value)).toBe('unknown');
  });
  it('preserves all waypoints or omits the whole route link without pruning', () => {
    const origin = { lat: 28, lon: 77 }, destination = { lat: 26, lon: 75 };
    expect(routeDirectionsUrl(origin, destination, [{ lat: 27, lon: 76 }, { lat: 26.5, lon: 75.5 }])).toBe('https://www.google.com/maps/dir/?api=1&origin=28,77&destination=26,75&waypoints=27%2C76%7C26.5%2C75.5');
    expect(routeDirectionsUrl(origin, destination, [{ lat: 27, lon: 76 }, { lat: 'bad', lon: 75.5 }])).toBeNull();
    expect(routeDirectionsUrl({ lat: 91, lon: 77 }, destination, [])).toBeNull();
  });
  it('makes Directions links only from valid numeric coordinates, including zero and boundaries', () => {
    expect(stationDirectionsUrl(0, 0)).toBe('https://www.google.com/maps/dir/?api=1&destination=0%2C0');
    expect(stationDirectionsUrl(-90, 180)).toBe('https://www.google.com/maps/dir/?api=1&destination=-90%2C180');
  });
  it.each([['28', 77], [28, '77'], ['28" data-proof="inert', 77], [null, 77], [NaN, 77], [Infinity, 77], [91, 77], [28, 181], [-91, 77], [28, -181]])('refuses an unsupported coordinate pair: %j,%j', (lat, lon) => {
    expect(stationDirectionsUrl(lat, lon)).toBeNull();
  });
});
