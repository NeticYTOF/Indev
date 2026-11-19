// Dev probe: replay the Delhi->Jaipur corridor samples to find failing coordinates.
import { OsrmRouter } from '../packages/core/src/router.js';
import { PhotonGeocoder } from '../packages/core/src/geocode.js';
import { StatiqClient } from '../packages/core/src/statiq.js';
import { cumulativeKm, pointAtChainage } from '../packages/core/src/geo.js';

const token = process.env.STATIQ_API_TOKEN;
if (!token) {
  console.error('STATIQ_API_TOKEN missing');
  process.exit(1);
}

const origin = { lat: 28.6139, lon: 77.209 };
const dest = { lat: 26.9124, lon: 75.7873 };
const router = new OsrmRouter();
const statiq = new StatiqClient({ token, cacheTtlMs: 0 });

const route = await router.route(origin, dest);
const cum = cumulativeKm(route.geometry);
const totalKm = cum[cum.length - 1] ?? 0;
console.log(`route ${totalKm.toFixed(1)} km`);

const fails: string[] = [];
for (let d = 0; d < totalKm; d += 12) {
  const p = pointAtChainage(route.geometry, cum, d);
  try {
    const res = await statiq.markers(p.lat, p.lon);
    process.stdout.write('.');
  } catch (err) {
    process.stdout.write('X');
    fails.push(`km ${d.toFixed(0)}: lat ${p.lat.toFixed(4)} lon ${p.lon.toFixed(4)} -> ${(err as Error).message}`);
  }
}
console.log('');
for (const f of fails) console.log(f);
console.log(`fail count: ${fails.length}`);
