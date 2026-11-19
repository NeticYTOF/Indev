// Dev utility: sample station details across cities and aggregate the
// connector status vocabulary (type/status/available/note) plus charger types.
import { writeFileSync } from 'node:fs';

const BASE = 'https://harrier-evroute.aaravnirajsingh.workers.dev/api';
const token = process.env.STATIQ_API_TOKEN;
if (!token) {
  console.error('STATIQ_API_TOKEN is missing.');
  process.exit(1);
}

const centers = [
  { label: 'Delhi', latitude: 28.6139, longitude: 77.209 },
  { label: 'Jaipur', latitude: 26.9124, longitude: 75.7873 },
  { label: 'Mumbai', latitude: 19.076, longitude: 72.8777 },
  { label: 'Chennai', latitude: 13.0827, longitude: 80.2707 },
];

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

const ids = new Set();
for (const c of centers) {
  const j = await post('/stations/markers', c);
  const stations = j.stations ?? [];
  // spread-sample across the returned list
  for (let i = 0; i < stations.length; i += Math.ceil(stations.length / 12)) {
    ids.add(stations[i].stationId);
  }
}
console.log(`Sampling ${ids.size} stations...`);

const connectorVocab = new Map();
const chargerTypes = new Map();
const connectorTypes = new Map();
const amenities = new Map();
const prices = [];
const lastUsedFormats = new Set();

let done = 0;
for (const id of ids) {
  const j = await post('/stations/details', { station_id: id });
  const s = j.station;
  if (!s) continue;
  (s.amenities ?? []).forEach((a) => amenities.set(a, (amenities.get(a) ?? 0) + 1));
  for (const ch of s.chargers ?? []) {
    chargerTypes.set(ch.type, (chargerTypes.get(ch.type) ?? 0) + 1);
    if (typeof ch.pricePerKwh === 'number') prices.push(ch.pricePerKwh);
    if (ch.lastUsedOn) lastUsedFormats.add(ch.lastUsedOn);
    for (const c of ch.connectors ?? []) {
      connectorTypes.set(c.type, (connectorTypes.get(c.type) ?? 0) + 1);
      const key = `${c.type} | status=${c.status} | available=${c.available} | note=${c.note ?? '-'}`;
      connectorVocab.set(key, (connectorVocab.get(key) ?? 0) + 1);
    }
  }
  done++;
}

console.log(`\nsampled ${done} stations`);
console.log('\nchargerTypes:', JSON.stringify([...chargerTypes]));
console.log('connectorTypes:', JSON.stringify([...connectorTypes]));
console.log('amenities:', JSON.stringify([...amenities]));
prices.sort((a, b) => a - b);
console.log(
  `prices: n=${prices.length} min=${prices[0]} med=${prices[Math.floor(prices.length / 2)]} max=${prices[prices.length - 1]}`,
);
console.log('lastUsedOn samples:', JSON.stringify([...lastUsedFormats].slice(0, 6)));
console.log('\nconnector vocab (type|status|available|note -> count):');
for (const [k, v] of [...connectorVocab].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${v}x  ${k}`);
}
writeFileSync(
  new URL('./probe-vocab-out.json', import.meta.url),
  JSON.stringify([...connectorVocab], null, 2),
);
