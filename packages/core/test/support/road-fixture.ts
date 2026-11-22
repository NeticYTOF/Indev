import { haversineKm, type Coords } from '../../src/geo.js';
import { certifySelectedRouteLegs, type CertifiedRouteLegs } from '../../src/route-legs.js';
import type { OsrmRouter, RouteResult } from '../../src/router.js';

/** Router fixture whose reported road length follows the requested endpoints. */
export function endpointRouter(extraKm = 0): OsrmRouter {
  return { route: async (from: Coords, to: Coords): Promise<RouteResult> => {
    const distanceKm = haversineKm(from, to) + extraKm;
    return { distanceKm, durationMin: distanceKm, geometry: [from, to] };
  } } as unknown as OsrmRouter;
}

interface ChoiceSource {
  route: RouteResult;
  plan: { origin: { label: string; lat: number; lon: number };
    destination: { label: string; lat: number; lon: number };
    via?: readonly { label: string; lat: number; lon: number }[] };
  usableCandidates: readonly {
    candidate: { stationId: number; name: string; lat: number; lon: number; chainageKm: number };
  }[];
}

/** Build a real road certificate for the selected station sequence in a test bundle. */
export async function certificateForChoice(bundle: ChoiceSource, stationIds: readonly number[],
  router: OsrmRouter): Promise<CertifiedRouteLegs> {
  const byId = new Map(bundle.usableCandidates.map((c) => [c.candidate.stationId, c]));
  return certifySelectedRouteLegs(router, bundle.route, bundle.plan.origin, bundle.plan.destination,
    bundle.plan.via ?? [], stationIds.map((id) => {
      const c = byId.get(id);
      if (c == null) throw new Error(`test fixture missing candidate ${id}`);
      return { stationId: id, label: c.candidate.name,
        coords: { lat: c.candidate.lat, lon: c.candidate.lon },
        chainageKm: c.candidate.chainageKm };
    }));
}
