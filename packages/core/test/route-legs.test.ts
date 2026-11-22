import { describe, expect, it } from 'vitest';
import { cumulativeKm, haversineKm } from '../src/geo.js';
import { certifySelectedRouteLegs, RouteCertificationError } from '../src/route-legs.js';
import type { OsrmRouter, RouteResult } from '../src/router.js';
import { endpointRouter } from './support/road-fixture.js';

const KM = 111.32;
const origin = { lat: 0, lon: 0 };
const destination = { lat: 300 / KM, lon: 0 };
const viaPoint = { lat: 100 / KM, lon: 0 };
const stopPoint = { lat: 150 / KM, lon: 0 };
const baseRoute: RouteResult = {
  distanceKm: 300, durationMin: 300, geometry: [origin, destination],
};
function road(from: { lat: number; lon: number }, to: { lat: number; lon: number }, extra = 0): RouteResult {
  const mid = { lat: (from.lat + to.lat) / 2 + extra / KM, lon: (from.lon + to.lon) / 2 };
  const geometry = [from, mid, to];
  const distanceKm = cumulativeKm(geometry).at(-1) as number;
  return { distanceKm, durationMin: distanceKm, geometry };
}
function recorder(extraFor: (from: { lat: number; lon: number }, to: { lat: number; lon: number }) => number) {
  const calls: Array<[unknown, unknown]> = [];
  const router = { route: async (from: { lat: number; lon: number }, to: { lat: number; lon: number }) => {
    calls.push([from, to]);
    return road(from, to, extraFor(from, to));
  } } as unknown as OsrmRouter;
  return { router, calls };
}

describe('actual selected road certification', () => {
  it('aggregates via segments into the charging leg and reuses the direct route with no stops', async () => {
    const { router, calls } = recorder(() => 0);
    const certified = await certifySelectedRouteLegs(router, baseRoute, origin, destination,
      [viaPoint], [{ stationId: 42, label: 'Stop 42', coords: stopPoint, chainageKm: 150 }]);
    expect(calls).toHaveLength(3);
    expect(certified.legs.map((leg) => leg.stationId)).toEqual([42, null]);
    expect(certified.legs[0]!.distanceKm).toBeGreaterThan(90);
    expect(certified.totalDistanceKm).toBe(certified.legs.reduce((sum, leg) => sum + leg.distanceKm, 0));
    const direct = recorder(() => 0);
    const zero = await certifySelectedRouteLegs(direct.router, baseRoute,
      origin, destination, [], []);
    expect(direct.calls).toHaveLength(0);
    expect(zero.legs).toHaveLength(1);
  });

  it('accepts reported road distance longer than simplified geometry', async () => {
    const router = { route: async (from: { lat: number; lon: number },
      to: { lat: number; lon: number }) => ({
      distanceKm: 230, durationMin: 230, geometry: [from, to],
    }) } as unknown as OsrmRouter;
    const certified = await certifySelectedRouteLegs(router, baseRoute,
      origin, destination, [], [
        { stationId: 42, label: 'Stop 42', coords: stopPoint, chainageKm: 150 },
      ]);
    expect(certified.legs[0]!.distanceKm).toBe(230);
  });

  it('rejects geometry that does not start and end at the certified waypoints', async () => {
    const router = { route: async () => ({
      distanceKm: 10, durationMin: 10, geometry: [origin, origin],
    }) } as unknown as OsrmRouter;
    await expect(certifySelectedRouteLegs(router, baseRoute, origin, destination, [], [
      { stationId: 42, label: 'Stop 42', coords: stopPoint, chainageKm: 150 },
    ])).rejects.toBeInstanceOf(RouteCertificationError);
  });

  it('uses the reported direct distance for the zero-stop certificate', async () => {
    const directBase: RouteResult = { ...baseRoute, distanceKm: 305 };
    const zero = await certifySelectedRouteLegs({} as OsrmRouter, directBase,
      origin, destination, [], []);
    expect(zero.totalDistanceKm).toBe(305);
    expect(zero.legs[0]!.distanceKm).toBe(305);
    expect(haversineKm(origin, destination)).toBeLessThan(305);
  });

  it('rejects a reported road length shorter than the endpoint separation', async () => {
    const router = { route: async (from: { lat: number; lon: number },
      to: { lat: number; lon: number }) => ({ distanceKm: 10, durationMin: 10,
        geometry: [from, to] }) } as unknown as OsrmRouter;
    await expect(certifySelectedRouteLegs(router, baseRoute, origin, destination, [], [
      { stationId: 42, label: 'Stop 42', coords: stopPoint, chainageKm: 150 },
    ])).rejects.toBeInstanceOf(RouteCertificationError);
  });

  it('rejects reversed supplied via order without sorting it away', async () => {
    await expect(certifySelectedRouteLegs(endpointRouter(), baseRoute, origin, destination,
      [{ lat: 200 / KM, lon: 0 }, viaPoint], [])).rejects.toThrow(/via points are not in forward route order/i);
  });

  it('rejects snapped segments that do not join at the same waypoint', async () => {
    const router = { route: async (from: { lat: number; lon: number },
      to: { lat: number; lon: number }) => {
      if (from.lat === 0) return { distanceKm: 100, durationMin: 100,
        geometry: [from, { lat: 100 / KM + 0.005, lon: 0 }] };
      if (from.lat === 100 / KM) return { distanceKm: 50, durationMin: 50,
        geometry: [{ lat: 100 / KM - 0.005, lon: 0 }, to] };
      return { distanceKm: 150, durationMin: 150, geometry: [from, to] };
    } } as unknown as OsrmRouter;
    await expect(certifySelectedRouteLegs(router, baseRoute, origin, destination, [viaPoint], [
      { stationId: 42, label: 'Stop 42', coords: stopPoint, chainageKm: 150 },
    ])).rejects.toThrow(/do not join/i);
  });
});
