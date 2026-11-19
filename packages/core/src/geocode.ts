/**
 * Photon geocoder client (free, no API key) with a mild India bias.
 * Used server-side for origin/destination search boxes.
 */
import type { Coords } from './geo.js';
import { sleep } from './utils.js';

export const DEFAULT_PHOTON_BASE_URL = 'https://photon.komoot.io';

export interface GeocodeHit {
  name: string;
  /** Human-readable label for the search box. */
  label: string;
  lat: number;
  lon: number;
  city: string | null;
  state: string | null;
  country: string | null;
}

export interface GeocoderOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  /** Bias for result ranking, e.g. the map center. */
  bias?: Coords;
}

interface PhotonProperties {
  name?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  street?: string | null;
  housenumber?: string | null;
  postcode?: string | null;
  osm_key?: string | null;
  osm_value?: string | null;
  extent?: number[];
}

interface PhotonResponse {
  features: Array<{
    geometry: { coordinates: [number, number] };
    properties: PhotonProperties;
  }>;
}

const INDIA_BIAS: Coords = { lat: 22.5, lon: 79 }; // rough geographic centre of India

export class PhotonGeocoder {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly bias: Coords;

  constructor(opts: GeocoderOptions = {}) {
    this.base = (opts.baseUrl ?? DEFAULT_PHOTON_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.retries = opts.retries ?? 1;
    this.bias = opts.bias ?? INDIA_BIAS;
  }

  /** Search places by free text (e.g. "Jaipur", "Connaught Place Delhi"). */
  async search(query: string, limit = 6): Promise<GeocodeHit[]> {
    const params = new URLSearchParams({
      q: query,
      limit: String(limit),
      lang: 'en',
      lat: String(this.bias.lat),
      lon: String(this.bias.lon),
    });
    const json = await this.getJson<PhotonResponse>(`${this.base}/api?${params.toString()}`);
    return (json.features ?? []).map((f) => toHit(f.properties ?? {}, f.geometry.coordinates));
  }

  private async getJson<T>(url: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(250 * 2 ** (attempt - 1));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, { signal: controller.signal });
        if (!res.ok) {
          lastError = new Error(`Photon HTTP ${res.status}`);
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
    throw lastError instanceof Error ? lastError : new Error('geocoding failed');
  }
}

function toHit(p: PhotonProperties, coords: [number, number]): GeocodeHit {
  const name = p.name ?? p.street ?? 'Unnamed place';
  const parts = [name, p.city, p.state, p.country].filter(
    (s): s is string => Boolean(s && s.trim()),
  );
  // de-duplicate consecutive repeats ("Delhi, Delhi, India")
  const dedup: string[] = [];
  for (const part of parts) {
    if (dedup[dedup.length - 1] !== part) dedup.push(part);
  }
  return {
    name,
    label: dedup.join(', '),
    lat: coords[1],
    lon: coords[0],
    city: p.city ?? null,
    state: p.state ?? null,
    country: p.country ?? null,
  };
}
