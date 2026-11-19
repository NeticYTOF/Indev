/**
 * Typed API client for the IndEV backend.
 * All calls go through the Vite dev proxy to the local server.
 */
import type { SavedTrip, TripPlan, VehicleCatalogEntry, GeocodeHit } from '@indeev/core';

export interface HealthInfo {
  ok: boolean;
  mock: boolean;
  chargersSeen: number;
}

export interface PlanRequest {
  origin: { label: string; lat: number; lon: number };
  destination: { label: string; lat: number; lon: number };
  vehicle?: {
    entryId?: string;
    custom?: { label?: string; batteryKwh: number; claimedRangeKwh?: number; realWorldRangeKm: number };
    realWorldRangeKm?: number;
  };
  startSocPct?: number;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  return handle<T>(res);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handle<T>(res);
}

async function handle<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Request failed (${res.status})`;
    const code = body && typeof body === 'object' && 'code' in body ? String(body.code) : 'unknown';
    throw new ApiError(message, code, res.status);
  }
  return body as T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const api = {
  health: () => get<HealthInfo>('/api/health'),
  vehicles: () =>
    get<{ default: string; catalog: VehicleCatalogEntry[]; note: string }>('/api/vehicles'),
  geocode: (q: string) => get<{ hits: GeocodeHit[] }>(`/api/geocode?q=${encodeURIComponent(q)}`),
  plan: (req: PlanRequest) => post<{ plan: TripPlan }>('/api/plan', req),
  trips: () => get<{ trips: SavedTrip[] }>('/api/trips'),
  trip: (id: string) => get<{ trip: SavedTrip }>(`/api/trips/${encodeURIComponent(id)}`),
  saveTrip: (plan: TripPlan, name?: string) => post<{ trip: SavedTrip }>('/api/trips', { plan, name }),
  deleteTrip: (id: string) => fetch(`/api/trips/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
