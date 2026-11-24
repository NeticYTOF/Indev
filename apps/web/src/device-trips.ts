/**
 * On-device saved trips for the hosted deployment.
 *
 * A hosted (serverless) server keeps no files between requests, so saved
 * trips live in this browser's localStorage instead. The stored form is the
 * exact minimal SavedTrip the server store writes (same `toSavedTrip`), and
 * every method answers with the same shape as the matching HTTP route, so
 * the drawer, save button and delete flow behave identically.
 *
 * Only used when /api/health reports `hosted: true`; local servers keep
 * their file store untouched.
 */
import { toSavedTrip, type SavedTrip } from '@indeev/core/trip-shape';
import type { TripPlan } from '@indeev/core';
import { ApiError } from './api.js';

const KEY = 'indeev.savedTrips.v1';

let hostedProbe: Promise<boolean> | null = null;

/** One health probe per page; any failure falls back to the server store. */
function probeHosted(): Promise<boolean> {
  hostedProbe ??= fetch('/api/health')
    .then((res) => (res.ok ? res.json() : null))
    .then((body: unknown) => Boolean(body && typeof body === 'object' && (body as { hosted?: unknown }).hosted === true))
    .catch(() => false);
  return hostedProbe;
}

function isSavedTrip(value: unknown): value is SavedTrip {
  if (!value || typeof value !== 'object') return false;
  const trip = value as Partial<SavedTrip>;
  return typeof trip.id === 'string' && typeof trip.name === 'string' &&
    typeof trip.createdAt === 'string' && Array.isArray(trip.geometry) && Array.isArray(trip.stations);
}

function readAll(): SavedTrip[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    throw new ApiError('Saved trips are unavailable: this browser blocks on-device storage.', 'storage_unavailable', 0);
  }
  if (raw == null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never overwrite unreadable data: a later save would destroy it.
    throw new ApiError('Saved trips on this device could not be read.', 'storage_corrupt', 0);
  }
  if (!Array.isArray(parsed)) throw new ApiError('Saved trips on this device could not be read.', 'storage_corrupt', 0);
  return parsed.filter(isSavedTrip);
}

function writeAll(trips: SavedTrip[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(trips));
  } catch {
    throw new ApiError('The trip could not be saved: on-device storage is full or blocked.', 'storage_unavailable', 0);
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const deviceTrips = {
  active: probeHosted,
  async list(): Promise<{ trips: SavedTrip[] }> {
    return { trips: readAll() };
  },
  async get(id: string): Promise<{ trip: SavedTrip }> {
    const trip = readAll().find((t) => t.id === id);
    if (!trip) throw new ApiError('Trip not found', 'not_found', 404);
    return { trip };
  },
  async save(plan: TripPlan, name?: string): Promise<{ trip: SavedTrip }> {
    // Same minimum shape the server route checks before saving.
    if (!plan || typeof plan !== 'object' || typeof plan.id !== 'string' || !plan.origin || !plan.destination ||
      !Array.isArray(plan.geometry) || !Array.isArray(plan.stops) || !plan.totals || !plan.vehicle) {
      throw new ApiError('A live plan object is required to save a trip', 'bad_request', 400);
    }
    const trips = readAll();
    const saved = toSavedTrip(plan, name);
    const index = trips.findIndex((t) => t.id === saved.id);
    if (index >= 0) trips[index] = saved; else trips.unshift(saved);
    writeAll(trips);
    return { trip: saved };
  },
  /** Same contract as `fetch(DELETE /api/trips/:id)`: a Response. */
  async remove(id: string): Promise<Response> {
    try {
      const trips = readAll();
      const next = trips.filter((t) => t.id !== id);
      if (next.length === trips.length) return jsonResponse({ error: 'Trip not found', code: 'not_found' }, 404);
      writeAll(next);
      return jsonResponse({ ok: true }, 200);
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : 'Delete failed', code: 'storage_unavailable' }, 500);
    }
  },
};
