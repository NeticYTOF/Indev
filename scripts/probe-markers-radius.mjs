// Dev utility: measure the /stations/markers fetch radius.
// Calls markers with a few centers and prints the distance distribution
// (min/median/max km) of returned stations, so corridor fetching can be tuned.
const BASE = 'https://harrier-evroute.aaravnirajsingh.workers.dev/api';
const token = process.env.STATIQ_API_TOKEN;
if (!token) {
  console.error('STATIQ_API_TOKEN is missing.');
  process.exit(1);
}

const centers = [
  { label: 'Delhi', latitude: 28.6139, longitude: 77.209 },
  { label: 'Jaipur', latitude: 26.9124, longitude: 75.7873 },
  { label: 'rural UP (Agra-Mathura gap)', latitude: 27.35, longitude: 77.9 },
  { label: 'Agra (Mathura is ~50km N)', latitude: 27.1765, longitude: 78.0081 },
  { label: 'E of Chennai (city 15-25km W)', latitude: 12.9, longitude: 80.23 },
];

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

for (const c of centers) {
  const res = await fetch(`${BASE}/stations/markers`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ latitude: c.latitude, longitude: c.longitude }),
  });
  const json = await res.json();
  const stations = json.stations ?? [];
  const dists = stations
    .map((s) => haversineKm(c.latitude, c.longitude, s.lat, s.lon))
    .sort((a, b) => a - b);
  const at = (i) => (dists.length ? dists[Math.min(i, dists.length - 1)] : null);
  console.log(
    `${c.label}: status=${res.status} count=${json.count} min=${at(0)?.toFixed(1)}km med=${at(Math.floor(dists.length / 2))?.toFixed(1)}km p90=${at(Math.floor(dists.length * 0.9))?.toFixed(1)}km max=${at(dists.length - 1)?.toFixed(1)}km`,
  );
}
