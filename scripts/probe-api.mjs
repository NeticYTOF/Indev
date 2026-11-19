// Dev utility: probe the Statiq API replica.
// Usage: node --env-file=.env scripts/probe-api.mjs [GET|POST] /path [jsonBody] [--full]
// The token is read from STATIQ_API_TOKEN and never printed.
// Prints a compact summary by default; --full prints the whole body.
// Full bodies are always saved to scripts/probe-out.json for inspection.
import { writeFileSync } from 'node:fs';

const BASE = 'https://harrier-evroute.aaravnirajsingh.workers.dev/api';

const args = process.argv.slice(2);
const full = args.includes('--full');
const [method = 'GET', path = '/', body] = args.filter((a) => a !== '--full');

const token = process.env.STATIQ_API_TOKEN;
if (!token) {
  console.error('STATIQ_API_TOKEN is missing. Add it to .env first.');
  process.exit(1);
}

const res = await fetch(BASE + path, {
  method,
  headers: {
    Authorization: `Bearer ${token}`,
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  },
  body,
  redirect: 'manual',
});

console.log(`${method} ${path} -> ${res.status} ${res.statusText}`);
const text = await res.text();
writeFileSync(new URL('./probe-out.json', import.meta.url), text);

let json;
try {
  json = JSON.parse(text);
} catch {
  console.log('(non-JSON body)', text.slice(0, 500));
  process.exit(0);
}

if (full) {
  console.log(JSON.stringify(json, null, 2));
} else {
  console.log(summary(json));
}

function summary(value, depth = 0) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (depth >= 2) return `[array of ${value.length}]`;
    const inner = value.slice(0, 2).map((v) => summary(v, depth + 1));
    return `[${value.length}] ${inner.join(' | ')}`;
  }
  const entries = Object.entries(value).map(([k, v]) => {
    const s =
      v === null || typeof v !== 'object'
        ? JSON.stringify(v)?.slice(0, 80)
        : depth >= 1
          ? Array.isArray(v)
            ? `[${v.length}]`
            : '{…}'
          : summary(v, depth + 1);
    return `${k}: ${s}`;
  });
  return `{${entries.join(', ')}}`;
}
