// Dev probe: which marker coordinates fail, and does concurrency matter?
import { StatiqClient } from '../packages/core/src/statiq.js';

const token = process.env.STATIQ_API_TOKEN;
if (!token) {
  console.error('STATIQ_API_TOKEN missing');
  process.exit(1);
}

async function tryOne(client: StatiqClient, lat: number, lon: number, label: string) {
  try {
    const res = await client.markers(lat, lon);
    console.log(`${label} OK count=${res.count}`);
  } catch (err) {
    console.log(`${label} FAIL ${(err as Error).message}`);
  }
}

// sequential: Delhi center a few times (cache-busting via fresh clients? same)
const c1 = new StatiqClient({ token });
await tryOne(c1, 28.6139, 77.209, 'delhi-1');
await tryOne(c1, 28.6139, 77.209, 'delhi-2(same client)');
await tryOne(c1, 28.6139, 77.209, 'delhi-3(same client)');

// concurrency test: 6 parallel fresh calls to the same city
const results = await Promise.all(
  Array.from({ length: 6 }, (_, i) => tryOne(new StatiqClient({ token }), 28.6139 + i * 0.001, 77.209 + i * 0.001, `parallel-${i}`)),
);
console.log('done', results.length);

// rapid-fire sequential with fresh clients (rate limit?)
for (let i = 0; i < 8; i++) {
  await tryOne(new StatiqClient({ token }), 26.9124 + i * 0.01, 75.7873, `seq-fresh-${i}`);
}
