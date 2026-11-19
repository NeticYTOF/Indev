/**
 * OSRM routing client (free demo server, no API key).
 * Returns the fastest driving route with full geometry for corridor sampling.
 */
import type { Coords } from './geo.js';
import { sleep } from './utils.js';

export const DEFAULT_OSRM_BASE_URL = 'https://router.project-osrm.org';

export class RouterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RouterError';
  }
}

export interface RouteResult {
  distanceKm: number;
  durationMin: number;
  geometry: Coords[];
}

export interface RouterClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
}

interface OsrmRoute {
  distance: number; // meters
  duration: number; // seconds
  geometry: { coordinates: [number, number][] };
}

interface OsrmResponse {
  code: string;
  message?: string;
  routes?: OsrmRoute[];
}

export class OsrmRouter {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(opts: RouterClientOptions = {}) {
    this.base = (opts.baseUrl ?? DEFAULT_OSRM_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retries = opts.retries ?? 2;
  }

  /** Fastest driving route between two points. */
  async route(origin: Coords, destination: Coords): Promise<RouteResult> {
    const coord = (c: Coords) => `${c.lon.toFixed(6)},${c.lat.toFixed(6)}`;
    const url =
      `${this.base}/route/v1/driving/${coord(origin)};${coord(destination)}` +
      `?overview=full&geometries=geojson`;
    const json = await this.getJson<OsrmResponse>(url);
    if (json.code !== 'Ok' || !json.routes || json.routes.length === 0) {
      throw new RouterError(json.code ?? 'Unknown', `No route: ${json.message ?? json.code}`);
    }
    const r = json.routes[0] as OsrmRoute;
    const coordinates = r?.geometry?.coordinates;
    if (
      !r || !Number.isFinite(r.distance) || r.distance < 0 ||
      !Number.isFinite(r.duration) || r.duration < 0 ||
      !Array.isArray(coordinates) || coordinates.length < 2 ||
      coordinates.some((point) => !Array.isArray(point) || point.length < 2 ||
        !Number.isFinite(point[0]) || Math.abs(point[0]) > 180 ||
        !Number.isFinite(point[1]) || Math.abs(point[1]) > 90)
    ) {
      // A successful HTTP/code status is not proof of a usable route.
      // Reject the whole payload before corridor scanning or plan claims.
      throw new RouterError('InvalidResponse', 'Routing response contained invalid distance, duration or geometry');
    }
    return {
      distanceKm: r.distance / 1000,
      durationMin: r.duration / 60,
      geometry: r.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })),
    };
  }

  private async getJson<T>(url: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        // exponential backoff with full jitter, capped
        const base = 250 * 2 ** Math.min(attempt, 4);
        await sleep(Math.min(Math.random() * base, 4_000) + 100);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, { signal: controller.signal });
        if (!res.ok) {
          lastError = new RouterError(`HTTP ${res.status}`, `OSRM HTTP ${res.status}`);
          continue;
        }
        return (await res.json()) as T;
      } catch (err) {
        lastError = err;
        continue;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new RouterError('Network', 'routing failed');
  }
}
