// Dev debug: dump the planner's chosen stops for a synthetic 700 km world.
import { planTrip } from '../packages/core/src/planner.js';
import type { OsrmRouter, RouteResult } from '../packages/core/src/router.js';
import type { StatiqClient } from '../packages/core/src/statiq.js';
import type {
  StatiqDetailsResponse,
  StatiqMarkersResponse,
  StatiqStationDetail,
} from '../packages/core/src/types.js';

const KM_PER_DEG = 111.32;
const totalKm = 700;

const geometry = Array.from({ length: 71 }, (_, i) => ({
  lat: (totalKm / KM_PER_DEG) * (i / 70),
  lon: 0,
}));
const route: RouteResult = { distanceKm: totalKm, durationMin: totalKm, geometry };
const router = { route: async () => route } as unknown as OsrmRouter;

const specs = Array.from({ length: 14 }, (_, i) => ({ id: 200 + i, chainageKm: 50 * (i + 1), name: `Statiq ${i}` }));
const details = new Map<number, StatiqStationDetail>(
  specs.map((s) => [
    s.id,
    {
      stationId: s.id,
      name: s.name,
      lat: s.chainageKm / KM_PER_DEG,
      lon: 0,
      address: null,
      area: null,
      city: null,
      landmark: null,
      hours: null,
      openText: null,
      rating: 4,
      reviewCount: 100,
      accessType: 'public',
      navUrl: '',
      stationUrl: '',
      imageUrl: null,
      amenities: [],
      stepsToReach: null,
      chargers: [
        {
          chargerId: s.id * 10 + 1,
          name: 'DC',
          type: 'DC',
          kw: 120,
          pricePerKwh: 22.5,
          currency: 'INR',
          lastUsedOn: null,
          connectors: [{ displayId: 1, connectorId: s.id * 100, type: 'CCS-2', status: 'available', available: true, note: null }],
        },
      ],
      summary: null,
    } as StatiqStationDetail,
  ]),
);
const statiq = {
  markers: async (lat: number): Promise<StatiqMarkersResponse> => {
    const centerKm = lat * KM_PER_DEG;
    const stations = specs
      .filter((s) => Math.abs(s.chainageKm - centerKm) <= 13)
      .map((s) => {
        const d = details.get(s.id) as StatiqStationDetail;
        return { stationId: s.id, name: s.name, lat: d.lat, lon: 0, address: null, accessType: 1, isCommunityListed: false, stationUrl: '' };
      });
    return { ok: true, live: true, retained: false, source: 't', count: stations.length, stations };
  },
  details: async (id: number): Promise<StatiqDetailsResponse> => ({
    ok: true,
    live: true,
    retained: false,
    source: 't',
    station: details.get(id) ?? null,
  }),
  detailsWithMeta: async (id: number) => ({
    response: {
      ok: true,
      live: true,
      retained: false,
      source: 't',
      station: details.get(id) ?? null,
    },
    fetchedAt: new Date(),
  }),
} as unknown as StatiqClient;

const plan = await planTrip(
  { router, statiq },
  { label: 'O', lat: 0, lon: 0 },
  { label: 'D', lat: totalKm / KM_PER_DEG, lon: 0 },
);
console.log('totalKm along geometry:', plan.routeDistanceKm);
for (const s of plan.stops) {
  console.log(
    `${s.station.name} chainage=${s.chainageKm} leg=${s.legKm} arrive=${s.arriveSocPct}% leave=${s.leaveSocPct}% kwh=${s.chargeKwh} min=${s.chargeTimeMin} eta=${s.arrivalEtaMin}`,
  );
}
console.log('warnings:', plan.warnings);
console.log('totals:', plan.totals);
