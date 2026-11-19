// Dev probe: measure the replica's rolling quota for markers calls.
import { StatiqClient } from '../packages/core/src/statiq.js';

const token = process.env.STATIQ_API_TOKEN;
if (!token) {
  console.error('STATIQ_API_TOKEN missing');
  process.exit(1);
}
const statiq = new StatiqClient({ token, retries: 0, cacheTtlMs: 0 });

const t0 = Date.now();
let ok = 0;
let first429: number | null = null;
for (let i = 0; i < 80; i++) {
  try {
    await statiq.markers(28.6139 + (i % 7) * 0.001, 77.209 + (i % 3) * 0.001);
    ok++;
    process.stdout.write('.');
  } catch (err) {
    const msg = (err as Error).message;
    const is429 = msg.includes(' 429 ');
    process.stdout.write(is429 ? 'R' : 'E');
    if (is429 && first429 === null) first429 = i;
    if (!is429) console.log(`\n[${i}] ${msg}`);
    if (first429 !== null) break; // stop at first rate-limit hit
  }
  await new Promise((r) => setTimeout(r, 40));
}
const secs = (Date.now() - t0) / 1000;
console.log(`\nfirst 429 at call #${first429} after ${ok} ok calls in ${secs.toFixed(1)}s`);
