/**
 * Pure local filtering and ordering for the saved-trips drawer.
 * No API requests, provider calls, persistence or mutation of stored facts.
 */
import type { SavedTrip } from '@indeev/core';

export type TripListSort = 'newest' | 'oldest' | 'name';
export type TripSourceFilter = 'all' | 'live' | 'synthetic' | 'unknown';
export type TripStatusFilter = 'all' | 'ok' | 'degraded' | 'unknown';

export interface TripListFilters {
  readonly source?: TripSourceFilter;
  readonly status?: TripStatusFilter;
}

export interface TripListEntry {
  readonly trip: SavedTrip;
  /** Index in the original API-loaded array; all actions must use this. */
  readonly sourceIndex: number;
}

type KnownSource = Exclude<TripSourceFilter, 'all' | 'unknown'>;
type KnownStatus = Exclude<TripStatusFilter, 'all' | 'unknown'>;

interface RankedTrip extends TripListEntry {
  readonly name: string;
  readonly origin: string;
  readonly destination: string;
  readonly createdAtMs: number | null;
  readonly source: KnownSource | 'unknown';
  readonly status: KnownStatus | 'unknown';
}

function exactClass<T extends string>(value: unknown, known: readonly T[]): T | 'unknown' {
  return typeof value === 'string' && known.includes(value as T) ? value as T : 'unknown';
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function createdAtMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ranked(trips: readonly SavedTrip[]): RankedTrip[] {
  return trips.map((trip, sourceIndex) => {
    const raw = record(trip) ?? {};
    return {
      trip,
      sourceIndex,
      name: text(raw.name),
      origin: text(record(raw.origin)?.label),
      destination: text(record(raw.destination)?.label),
      createdAtMs: createdAtMs(raw.createdAt),
      source: exactClass(raw.source, ['live', 'synthetic'] as const),
      status: exactClass(raw.status, ['ok', 'degraded'] as const),
    };
  });
}

function compareDates(a: RankedTrip, b: RankedTrip, sort: 'newest' | 'oldest'): number {
  // Unknown dates are always last in either direction; ties keep load order.
  if (a.createdAtMs == null && b.createdAtMs == null) return a.sourceIndex - b.sourceIndex;
  if (a.createdAtMs == null) return 1;
  if (b.createdAtMs == null) return -1;
  const delta = sort === 'newest' ? b.createdAtMs - a.createdAtMs : a.createdAtMs - b.createdAtMs;
  return delta !== 0 ? delta : a.sourceIndex - b.sourceIndex;
}

/** Returns a new ordered list; the input array and every trip stay untouched. */
export function filterAndSortTrips(
  trips: readonly SavedTrip[],
  query: string,
  sort: TripListSort,
  filters: TripListFilters = {},
): TripListEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  const source = filters.source ?? 'all';
  const status = filters.status ?? 'all';
  const entries = ranked(trips);
  const matching = entries.filter((entry) => {
    const textMatch = needle.length === 0 ||
      `${entry.name}\n${entry.origin}\n${entry.destination}`.toLocaleLowerCase().includes(needle);
    return textMatch &&
      (source === 'all' || entry.source === source) &&
      (status === 'all' || entry.status === status);
  });
  const sorted = [...matching];
  sorted.sort((a, b) => {
    if (sort === 'name') {
      const byName = a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase());
      return byName !== 0 ? byName : a.sourceIndex - b.sourceIndex;
    }
    return compareDates(a, b, sort);
  });
  return sorted.map(({ trip, sourceIndex }) => ({ trip, sourceIndex }));
}
