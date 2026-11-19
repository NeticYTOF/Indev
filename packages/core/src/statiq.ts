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
 * - The rolling-window limiter spaces calls out (anti-burst) and hard-caps
 *   calls per 60s; it is abort-aware so a run deadline cancels cleanly.
 * - 429 responses are honored via Retry-After when present; retries are
 *   capped and combined with exponential backoff + jitter. Persistent
 *   throttling fails CLOSED at the planner level: "plan not determined",
 *   never a falsely-confident plan.
 */
import type {
  StatiqCardsResponse,
  StatiqDetailsResponse,
  StatiqMarkersResponse,
} from './types.js';
import { sleep as defaultSleep } from './utils.js';

export const DEFAULT_STATIQ_BASE_URL =
  'https://harrier-evroute.aaravnirajsingh.workers.dev/api';

export class StatiqApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
    readonly retryAfterMs?: number,
  ) {
    // Body text is upstream-controlled JSON; keep it short and never
    // include request headers (token safety).
    super(`Statiq API ${status} on ${path}: ${body.slice(0, 200)}`);
    this.name = 'StatiqApiError';
  }
}

/** Raised when a call is aborted (run deadline/budget reached). Never retried. */
export class StatiqAbortError extends Error {
  constructor(message = 'Statiq call aborted (run deadline or cancellation)') {
    super(message);
    this.name = 'StatiqAbortError';
  }
}

/** True for any abort-shaped error (ours, fetch's, or DOMException). */
export function isAbortLike(err: unknown): boolean {
  return (
    err instanceof StatiqAbortError ||
    (err instanceof Error && err.name === 'AbortError') ||
    (err instanceof Error && /aborted/i.test(err.message))
  );
}

export interface StatiqClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** in-memory details cache TTL; 0 disables caching */
  cacheTtlMs?: number;
  timeoutMs?: number;
  retries?: number;
  /**
   * Rolling-window limit: max upstream calls per 60s (default 25).
   * Smoothed by minCallGapMs below, so the budget cannot burst.
   */
  maxCallsPerMinute?: number;
  /** Minimum gap between upstream calls (default 2000ms, anti-burst). */
  minCallGapMs?: number;
  /** Injectable clock for deterministic limiter tests. */
  now?: () => number;
  /** Injectable sleep for deterministic limiter tests. */
  sleepImpl?: (ms: number) => Promise<void>;
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
  private readonly now: () => number;
  private readonly doSleep: (ms: number) => Promise<void>;
  private readonly detailsCache = new Map<number, CacheEntry>();
  private lastCallAt = Number.NEGATIVE_INFINITY;
  private callStamps: number[] = [];
  /** Serializes slot acquisition so concurrent callers cannot interleave. */
  private slotQueue: Promise<void> = Promise.resolve();

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
    this.minCallGapMs = opts.minCallGapMs ?? 2_000;
    this.now = opts.now ?? Date.now;
    this.doSleep = opts.sleepImpl ?? defaultSleep;
  }

  /** Stations near a point (~13 km radius, capped at 256 by the upstream). */
  markers(lat: number, lon: number, signal?: AbortSignal): Promise<StatiqMarkersResponse> {
    return this.postJson('/stations/markers', { latitude: lat, longitude: lon }, signal);
  }

  /** Nearest station cards around a point. */
  cards(lat: number, lon: number, signal?: AbortSignal): Promise<StatiqCardsResponse> {
    return this.postJson('/stations/cards', { latitude: lat, longitude: lon }, signal);
  }

  /**
   * Full details with a fetched-at timestamp. The memo returns the original
   * fetch time (not access time) so status displays stay honest.
   */
  async detailsWithMeta(stationId: number, signal?: AbortSignal): Promise<StationDetailsWithMeta> {
    const cached = this.detailsCache.get(stationId);
    if (cached && this.now() - cached.at < this.cacheTtlMs) {
      return { response: cached.response, fetchedAt: cached.fetchedAt };
    }
    const response = await this.postJson<StatiqDetailsResponse>('/stations/details', {
      station_id: stationId,
    }, signal);
    const fetchedAt = new Date();
    if (response && response.station) {
      this.detailsCache.set(stationId, { at: this.now(), response, fetchedAt });
    }
    return { response, fetchedAt };
  }

  /** Wire-shaped details (no fetch metadata). */
  async details(stationId: number, signal?: AbortSignal): Promise<StatiqDetailsResponse> {
    return (await this.detailsWithMeta(stationId, signal)).response;
  }

  /**
   * Backoff between attempts. When the upstream sent Retry-After (parsed
   * to ms), it is honored (capped at 90s) with a small jitter allowance.
   * Otherwise: exponential with full jitter, capped at 4s.
   */
  private async backoffMs(attempt: number, retryAfterMs?: number): Promise<void> {
    if (retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      await this.doSleep(Math.min(retryAfterMs, 90_000) + Math.random() * 250);
      return;
    }
    const base = 250 * 2 ** Math.min(attempt, 4); // caps the exponential at 4s
    const jittered = Math.random() * base; // full jitter: 0..base
    await this.doSleep(Math.min(jittered, 4_000) + 100);
  }

  /**
   * Rolling-window rate limiter. Guaranteed properties (unit-tested with
   * a mocked transport and clock):
   * - no two upstream calls closer than `minCallGapMs`
   * - never more than `maxCallsPerMinute` calls in ANY rolling 60s window
   *   (stamps are retained 62s so boundary windows stay conservative)
   * - aborts promptly when `signal` fires while waiting (poll sleeps are
   *   capped at 200ms)
   * Waiters are SERIALIZED through `slotQueue`: only one waiter evaluates
   * the gap/window state at a time, so concurrent bursts cannot interleave
   * between the check and the stamp.
   */
  private acquireSlot(signal?: AbortSignal): Promise<void> {
    const turn = this.slotQueue.then(() => this.acquireSlotLocked(signal));
    // keep the queue moving even if this waiter aborts/fails
    this.slotQueue = turn.catch(() => {});
    return turn;
  }

  private async acquireSlotLocked(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new StatiqAbortError();
      const now = this.now();
      // Retain stamps past the window: a push is only allowed when even the
      // most conservative 60s window (ending now) holds < max calls.
      const RETENTION_MS = 62_000;
      this.callStamps = this.callStamps.filter((t) => now - t < RETENTION_MS);
      const gapWait = this.lastCallAt + this.minCallGapMs - now;
      const windowFull = this.callStamps.length >= this.maxCallsPerMinute;
      if (!windowFull && gapWait <= 0) {
        const stamp = Math.max(now, this.lastCallAt + this.minCallGapMs);
        this.callStamps.push(stamp);
        this.lastCallAt = stamp;
        return;
      }
      const oldest = this.callStamps[0] ?? now;
      const windowWait = windowFull ? RETENTION_MS - (now - oldest) + 50 : 0;
      // wait at most ~200ms so an abort is noticed within one poll cycle
      await this.doSleep(Math.min(Math.max(gapWait, windowWait, 50), 200));
    }
  }

  private async postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    let lastError: unknown;
    let lastRetryAfterMs: number | undefined;
    // 1 initial attempt + `retries` retries; aborts are never retried
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        const override = lastRetryAfterMs;
        lastRetryAfterMs = undefined;
        await this.backoffMs(attempt, override);
      }
      await this.acquireSlot(signal);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const onOuterAbort = () => controller.abort();
      signal?.addEventListener('abort', onOuterAbort, { once: true });
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
          const retryAfter =
            res.status === 429 ? this.parseRetryAfterMs(res.headers?.get('retry-after')) : undefined;
          // 4xx (except 429) are permanent: do not retry.
          if (res.status >= 500 || res.status === 429) {
            lastError = new StatiqApiError(res.status, path, text, retryAfter);
            lastRetryAfterMs = retryAfter;
            continue;
          }
          throw new StatiqApiError(res.status, path, text, retryAfter);
        }
        return JSON.parse(text) as T;
      } catch (err) {
        // aborts propagate immediately; they are never retried
        if (signal?.aborted || (signal && isAbortLike(err))) {
          throw new StatiqAbortError();
        }
        if (err instanceof StatiqApiError && err.status < 500 && err.status !== 429) {
          throw err;
        }
        lastError = err;
        continue;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onOuterAbort);
      }
    }
    if (lastError instanceof StatiqApiError) throw lastError;
    throw new StatiqApiError(0, path, lastError instanceof Error ? lastError.message : 'network error');
  }

  /** Parse Retry-After (delay-seconds form). */
  private parseRetryAfterMs(header: string | null | undefined): number | undefined {
    if (!header) return undefined;
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    return undefined; // HTTP-date form: fall back to default backoff
  }
}
