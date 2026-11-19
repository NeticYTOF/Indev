# IndEV (rebuild)

EV route planner for India (like ABRP) for a **Tata Harrier EV 75 kWh** (plus an
India-market vehicle catalog), planning over **live** Statiq charger data.

## Two launch modes

| Mode | Command | What it does |
|---|---|---|
| **Normal (live)** | `npm run dev` | Server `:8787` runs **LIVE** against the real Statiq API using `STATIQ_API_TOKEN` from `.env`; web app on `:5173`. The token is used server-side only — it is never sent to the browser, never logged, and `.env` is never committed. |
| **Test (mock)** | `npm run dev:stack` | Isolated mock stack on the **same ports the visual pass uses** (`:8787` mock server, `:5173` web) — credential-free and fail-closed: the launcher verifies the startup log line, `health.mock=true`, and a synthetic plan probe before reporting READY, and exits non-zero otherwise. |
| **Test (mock, isolated ports)** | `npm run ui:verify` | Same fail-closed gates on dedicated ports (`:8788` server, `:5174` web) so a stale process can never answer instead. |

- Mock stacks are credential-free: `STATIQ_API_TOKEN` and `AI_*` vars are
  stripped from both children and the repo `.env` is not even loaded
  (`INDEV_SKIP_DOTENV=1`). Mock mode serves synthetic plans/stations, stores
  in separate `.mock` files, and visibly labels everything "Synthetic data".
- The AI planner (any OpenAI-compatible provider) is **off by default** and
  only enabled when `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL` are all set.
- The topbar badge and plan button always reflect the server's real mode from
  `/api/health` — "Live charger data" in live mode, "Synthetic data — mock
  mode" in mock mode.

## Setup

```sh
cp .env.example .env   # then fill STATIQ_API_TOKEN (server-side only)
npm install
npm run dev            # LIVE mode: server :8787 + web :5173
```

## Layout

- `packages/core` — planning domain: Statiq client (rate-limited, abort-aware,
  sanitized audit), OSRM router, Photon geocoder, corridor scan, planner,
  vehicle catalog (manufacturer claims strictly separate from user
  real-world range), saved-trips store, AI-choice validation.
- `apps/server` — HTTP API: live planning, mock mode, saved trips shared with
  MCP, station revalidation with fetchedAt, AI planning endpoint (off by
  default).
- `apps/web` — map UI (MapLibre + a dark OpenFreeMap basemap, flat solid-color
  "Night Drive" design with no gradients, mobile bottom sheet).
- `apps/mcp` — MCP stdio server (`plan_trip`, `list_saved_trips`,
  `get_station`) sharing the saved trips with the website. Launch with
  `node node_modules/tsx/dist/cli.mjs apps/mcp/src/index.ts` (avoid npm's
  Windows cmd shims, which can drop env vars).
- `scripts/` — dev utilities and the fail-closed test launchers; the live
  acceptance runner fails closed (mode and provenance gates, non-zero exit
  on any failure, retained per-run artifacts).
- `docs/planning-requests.md` — upstream request accounting: what one
  planning run costs, what the attempt budget counts (retries included),
  and the fail-closed stop semantics (first 429/401/403, exhaustion →
  honest not_determined).

## Data & privacy

- Charger data is always fetched live along the route; only a running count
  of chargers seen is persisted — never station data.
- Saved trips store minimal station references plus route geometry.
- Upstream audit logs are strictly sanitized: endpoint, status, timestamp and
  a per-run count — no auth headers, coordinates, bodies or route history.

## Tests

```sh
npm test         # full suite (isolated temp stores, mocked transports)
npm run typecheck
```
## Browser regression checks (Linux)

Requires Node 20 or newer. From a clean checkout:

```sh
npm ci
npm run test:browser:setup
npm run typecheck
npm run test:browser
```

On Linux hosts that already provide Chrome, the browser download can be skipped:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:browser
```

The browser command starts and stops its own isolated, credential-free mock
stack on ports 8788 and 5174. Keep those ports free. It refuses to reuse an
unknown web server. Saved trips use disposable test data, not the normal data
folder. The config does not start a live provider run. The failure test uses
intercepted synthetic responses, including optional AI controls for layout;
it is not evidence of live route completion. Third-party map requests are
blocked for this focused UI regression, so its screenshots have no basemap.

The checks cover mobile 390x844 and desktop 1280x800, title/guidance visibility
inside the planner scrollport, and restored retry-button focus. Browser specs
and config are included in `npm run typecheck`. Failure screenshots/traces and
successful reveal screenshots are written under ignored `test-results/`.
