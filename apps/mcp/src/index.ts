/**
 * IndEV MCP server (stdio).
 *
 * Tools: plan_trip, list_saved_trips, get_station — sharing the SAME saved
 * trips as the website (identical store files and DATA_DIR semantics).
 *
 * Launch configuration (avoid npm's Windows cmd shims - they can drop env):
 *   node <repo>/node_modules/tsx/dist/cli.mjs <repo>/apps/mcp/src/index.ts
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  CountersStore,
  OsrmRouter,
  PhotonGeocoder,
  PlanningError,
  StatiqClient,
  TripsStore,
  VehicleSelectionError,
  type UpstreamAuditEntry,
} from '@indeev/core';
import { join } from 'node:path';
import { loadMcpEnv, mcpRootDir } from './env.js';
import {
  getStationHandler,
  listSavedTripsHandler,
  planToStructured,
  planTripHandler,
  type McpToolDeps,
} from './tools.js';

const env = loadMcpEnv();

if (!env.mock && !env.statiqToken) {
  console.error(
    'STATIQ_API_TOKEN is missing. Add it to .env (see .env.example), or run with INDEV_MOCK=1 for store tools only.',
  );
  process.exit(1);
}

// PROVENANCE ISOLATION mirrors the HTTP server: mock mode uses separate
// store files; live records and synthetic records never mix.
const storeSuffix = env.mock ? '.mock' : '';
const deps: McpToolDeps = {
  mock: env.mock,
  trips: new TripsStore({ filePath: join(env.dataDir, `saved-trips${storeSuffix}.json`) }),
  counters: new CountersStore({ filePath: join(env.dataDir, `counters${storeSuffix}.json`) }),
  router: new OsrmRouter(),
  geocoder: new PhotonGeocoder(),
  createStatiq: () =>
    new StatiqClient({
      token: env.statiqToken as string,
      onUpstreamCall: (entry: UpstreamAuditEntry) => {
        // sanitized audit: endpoint + status + time + running count only
        console.error(JSON.stringify({ type: 'upstream', ...entry }));
      },
    }),
};

const server = new McpServer(
  { name: 'indeev', version: '0.1.0' },
  {
    // AI reads tool results; no sampling or roots needed
    capabilities: {},
  },
);

function toolErrorText(err: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

server.tool(
  'plan_trip',
  'Plan a charging route for an India-market EV (default: Tata Harrier EV 75 kWh). ' +
    'Fetches live Statiq chargers along the fastest route; fewest stops, ' +
    'legs within the selected vehicle safe range (300 km for the default Harrier). ' +
    'Optionally saves the trip (minimal station references only).',
  {
    origin: z.string().min(2).describe('Start: place name ("Jaipur") or "lat,lon"'),
    destination: z.string().min(2).describe('End: place name or "lat,lon"'),
    vehicleCatalogId: z
      .string()
      .optional()
      .describe('Catalog id, e.g. "tata-nexon-ev-lr-45". Omit for the default Harrier.'),
    vehicleRealWorldRangeKm: z
      .number()
      .positive()
      .optional()
      .describe('YOUR real-world range in km for the chosen vehicle. REQUIRED for non-default vehicles (claims never substitute).'),
    customVehicle: z
      .object({
        label: z.string().optional(),
        batteryKwh: z.number().positive(),
        claimedRangeKm: z.number().positive().optional(),
        realWorldRangeKm: z.number().positive(),
      })
      .optional()
      .describe('Fully custom vehicle (battery kWh + YOUR real-world range km).'),
    startSocPct: z.number().min(5).max(100).optional().describe('Current charge percent (default 100)'),
    save: z.string().optional().describe('Trip name; when set, the plan is saved to the shared store'),
  },
  async (args) => {
    try {
      const result = await planTripHandler(deps, {
        origin: args.origin,
        destination: args.destination,
        vehicleCatalogId: args.vehicleCatalogId,
        vehicleRealWorldRangeKm: args.vehicleRealWorldRangeKm,
        customVehicle: args.customVehicle,
        startSocPct: args.startSocPct,
        save: args.save,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text:
              result.summary +
              (result.savedTripId ? `\nSaved as trip ${result.savedTripId}.` : '') +
              '\nCharger data is live; status freshness is per-station fetchedAt.',
          },
        ],
        structuredContent: planToStructured(result.plan) as Record<string, unknown>,
      };
    } catch (err) {
      if (err instanceof PlanningError || err instanceof VehicleSelectionError) {
        return toolErrorText(err);
      }
      return toolErrorText(err);
    }
  },
);

server.tool(
  'list_saved_trips',
  'List trips saved from the website or this MCP server (shared store; minimal references only).',
  {},
  async () => {
    try {
      const result = await listSavedTripsHandler(deps);
      return { content: [{ type: 'text' as const, text: result.summary }] };
    } catch (err) {
      return toolErrorText(err);
    }
  },
);

server.tool(
  'get_station',
  'Live details for one Statiq charging station: rating, reviews, tariff, usable CCS2 plugs ' +
    '(occupancy is never reported), uncertain/faulted counts, last used, fetchedAt. ' +
    'Reliability is unavailable in public data.',
  {
    station_id: z.number().int().positive().describe('Statiq station id'),
  },
  async (args) => {
    try {
      const result = await getStationHandler(deps, args.station_id);
      return {
        content: [{ type: 'text' as const, text: result.summary }],
        structuredContent: result.station as unknown as Record<string, unknown>,
      };
    } catch (err) {
      return toolErrorText(err);
    }
  },
);

const root = mcpRootDir();
console.error(
  `IndEV MCP server starting (mock: ${env.mock}, data dir: ${join(env.dataDir, `saved-trips${storeSuffix}.json`)}, transport: stdio, root: ${root}).`,
);

await server.connect(new StdioServerTransport());
