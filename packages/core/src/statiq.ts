/**
 * Statiq API replica client.
 *
 * - Bearer token comes from the environment and is used ONLY here,
 *   server-side. It is never printed, logged, or included in error messages.
 * - MEMO POLICY: the in-memory details memo exists ONLY for reuse inside a
 *   single planning run (the same station can be examined twice within one
 *   plan). Callers must create a fresh client per planning run; memoized
 *   data must NEVER be presented as live status. Anything showing status
 *   carries a `fetchedAt` timestamp from `detailsWithMeta`.
 * - Retries cover transient upstream failures (5xx / 429 / network) with
 *   exponential backoff + jitter and a hard cap; never 4xx (permanent).
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
  /** Rolling-window limit: max upstream calls per 60s (default 25). */
  maxCallsPerMinute?: number;
  /** Fixed politeness gap between upstream calls (default 300ms). */
  minCallGapMs?: number;
}

interface CacheEntry {
  at: number;
  response: StatiqDetailsResponse;
  fetchedAt: Date;
}

export interface StationDetailsWithMeta {
  response: StatiqDetailsResponse;
  /** When this upstream response was actually fetched. */
  fetchedAt: Date;
}

export class StatiqClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly maxCallsPerMinute: number;
  private readonly minCallGapMs: number;
  private readonly detailsCache = new Map<number, CacheEntry>();
  private lastCallAt = 0;
  private callTimestamps: number[] = [];

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
    this.maxCallsPerMinute = opts.maxCallsPerMinute ?? 25;
    this.minCallGapMs = opts.minCallGapMs ?? 300;
  }

  /** Stations near a point (~13 km radius, capped at 256 by the upstream). */
  markers(lat: number, lon: number): Promise<StatiqMarkersResponse> {
    return this.postJson('/stations/markers', { latitude: lat, longitude: lon });
  }

  /** Nearest station cards around a point. */
  cards(lat: number, lon: number): Promise<StatiqCardsResponse> {
    return this.postJson('/stations/cards', { latitude: lat, longitude: lon });
  }

  /**
   * Full details with a fetched-at timestamp. The memo returns the original
   * fetch time (not access time) so status displays stay honest.
   */
  async detailsWithMeta(stationId: number): Promise<StationDetailsWithMeta> {
    const cached = this.detailsCache.get(stationId);
    if (cached && Date.now() - cached.at < this.cacheTtlMs) {
      return { response: cached.response, fetchedAt: cached.fetchedAt };
    }
    const response = await this.postJson<StatiqDetailsResponse>('/stations/details', {
      station_id: stationId,
    });
    const fetchedAt = new Date();
    if (response && response.station) {
      this.detailsCache.set(stationId, { at: Date.now(), response, fetchedAt });
    }
    return { response, fetchedAt };
  }

  /** Wire-shaped details (no fetch metadata). */
  async details(stationId: number): Promise<StatiqDetailsResponse> {
    return (await this.detailsWithMeta(stationId)).response;
  }

  /** Exponential backoff with full jitter, capped: no tight retry loops. */
  private async backoffMs(attempt: number): Promise<void> {
    const base = 250 * 2 ** Math.min(attempt, 4); // caps the exponential at 4s
    const jittered = Math.random() * base; // full jitter: 0..base
    await sleep(Math.min(jittered, 4_000) + 100);
  }

  /**
   * Rolling-window rate limiter: at most `maxCallsPerMinute` upstream calls
   * per 60s, with a minimum gap between calls. Waits (no tight loops) when
   * the budget is exhausted. Creates one client per planning run so the
   * limiter reflects that run's traffic.
   */
  private async acquireSlot(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.callTimestamps = this.callTimestamps.filter((t) => now - t < 60_000);
      const gapWait = this.lastCallAt + this.minCallGapMs - now;
      if (this.callTimestamps.length < this.maxCallsPerMinute && gapWait <= 0) {
        const stamp = Math.max(now, this.lastCallAt + this.minCallGapMs);
        this.callTimestamps.push(stamp);
        this.lastCallAt = stamp;
        return;
      }
      const windowWait =
        this.callTimestamps.length >= this.maxCallsPerMinute && this.callTimestamps[0] !== undefined
          ? 60_000 - (now - (this.callTimestamps[0] as number))
          : 0;
      await sleep(Math.max(gapWait, windowWait, 50) + Math.random() * 100);
    }
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    let lastError: unknown;
    // 1 initial attempt + `retries` retries, exponential backoff + jitter
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        await this.backoffMs(attempt);
      }
      await this.acquireSlot();
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
