/**
 * Statiq API replica client.
 *
 * - Bearer token comes from the environment and is used ONLY here,
 *   server-side. It is never printed, logged, or included in error messages.
 * - Short-lived in-memory details cache: within one planning run we may
 *   touch the same station twice; the cache keeps that polite. The default
 *   TTL (90s) is far shorter than anything that could be called "storing
 *   charger data" - nothing is persisted.
 * - Retries cover transient upstream failures (5xx / network / 429),
 *   never 4xx (permanent).
 */
import type {
  StatiqCardsResponse,
  StatiqDetailsResponse,
  StatiqMarkersResponse,
} from './types.js';
import { sleep } from './utils.js';

export const DEFAULT_STATIQ_BASE_URL =
  'https://harrier-evroute.aaravnirajsingh.workers.dev/api';

export class StatiqApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    // Body text is upstream-controlled JSON; keep it short and never
    // include request headers (token safety).
    super(`Statiq API ${status} on ${path}: ${body.slice(0, 200)}`);
    this.name = 'StatiqApiError';
  }
}

export interface StatiqClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** in-memory details cache TTL; 0 disables caching */
  cacheTtlMs?: number;
  timeoutMs?: number;
  retries?: number;
}

interface CacheEntry {
  at: number;
  value: StatiqDetailsResponse;
}

export class StatiqClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly detailsCache = new Map<number, CacheEntry>();

  constructor(opts: StatiqClientOptions) {
    if (!opts.token) {
      throw new Error('StatiqClient requires a token (set STATIQ_API_TOKEN)');
    }
    this.base = (opts.baseUrl ?? DEFAULT_STATIQ_BASE_URL).replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.cacheTtlMs = opts.cacheTtlMs ?? 90_000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retries = opts.retries ?? 2;
  }

  /** Stations near a point (~13 km radius, capped at 256 by the upstream). */
  markers(lat: number, lon: number): Promise<StatiqMarkersResponse> {
    return this.postJson('/stations/markers', { latitude: lat, longitude: lon });
  }

  /** Nearest station cards around a point. */
  cards(lat: number, lon: number): Promise<StatiqCardsResponse> {
    return this.postJson('/stations/cards', { latitude: lat, longitude: lon });
  }

  /** Full details (chargers, plugs, tariff, reviews) for one station. */
  async details(stationId: number): Promise<StatiqDetailsResponse> {
    const cached = this.detailsCache.get(stationId);
    if (cached && Date.now() - cached.at < this.cacheTtlMs) {
      return cached.value;
    }
    const value = await this.postJson<StatiqDetailsResponse>('/stations/details', {
      station_id: stationId,
    });
    if (value && value.station) {
      this.detailsCache.set(stationId, { at: Date.now(), value });
    }
    return value;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    let lastError: unknown;
    // 1 initial attempt + `retries` retries
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        await sleep(250 * 2 ** (attempt - 1));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(this.base + path, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await res.text();
        if (!res.ok) {
          // 4xx (except 429) are permanent: do not retry.
          if (res.status >= 500 || res.status === 429) {
            lastError = new StatiqApiError(res.status, path, text);
            continue;
          }
          throw new StatiqApiError(res.status, path, text);
        }
        return JSON.parse(text) as T;
      } catch (err) {
        if (err instanceof StatiqApiError && err.status < 500 && err.status !== 429) {
          throw err;
        }
        lastError = err;
        continue;
      } finally {
        clearTimeout(timer);
      }
    }
    if (lastError instanceof StatiqApiError) throw lastError;
    throw new StatiqApiError(0, path, lastError instanceof Error ? lastError.message : 'network error');
  }
}
