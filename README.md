# IndEV (rebuild)

EV route planner for India (like ABRP) for a **Tata Harrier EV 75 kWh**, planning over
**live** Statiq charger data. Statues of the rebuild:

- Node + TypeScript backend, web frontend, `npm run dev` to run locally.
- Free routing (OSRM) + geocoding (Photon). No paid services.
- Chargers are always fetched live along the route; never stored (only a running count).
- MCP server shares saved trips with the website.
- Optional AI trip planning (OpenAI-compatible), off by default.

## Setup

```sh
cp .env.example .env   # then fill STATIQ_API_TOKEN
npm install
npm run dev            # server on :8787, web on :5173
```

## Layout

- `packages/core` — planning domain: Statiq client, router, corridor fetch, planner, vehicles, saved trips.
- `apps/server` — HTTP API for the web app.
- `apps/web` — map UI.
- `apps/mcp` — MCP stdio server (plan_trip, list_saved_trips, get_station).
- `scripts/` — dev utilities.

Status: scaffolding. Docs will grow with the build.
