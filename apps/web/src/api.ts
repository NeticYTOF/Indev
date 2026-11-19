/**
 * Typed API client for the IndEV backend.
 * All calls go through the Vite dev proxy to the local server.
 */
import type { SavedTrip, TripPlan, VehicleCatalogEntry, GeocodeHit } from '@indeev/core';

export interface HealthInfo {
  ok: boolean;
  mock: boolean;
  chargersSeen: number | null;
  counterAvailable?: boolean;
  /** AI planning is only shown in the UI when this is true. */
  ai: boolean;
}

export interface PlanRequest {
  origin: { label: string; lat: number; lon: number };
  destination: { label: string; lat: number; lon: number };
  vehicle?: {
    entryId?: string;
    custom?: { label?: string; batteryKwh: number; claimedRangeKm?: number; realWorldRangeKm: number };
    realWorldRangeKm?: number;
  };
  startSocPct?: number;
}

export interface AiPlanRequest extends PlanRequest {
  /** Plain-text custom requests from the AI box (e.g. "prefer food stops"). */
  request?: string;
}

export interface AiPlanResponse {
  plan: TripPlan;
  ai: { applied: boolean; notes?: string; reason?: string };
}

async function get<T>(path: string): Promise<T> {
  const res = await request(path);
  return handle<T>(res);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handle<T>(res);
}

/** Fetch wrapper: a failed fetch (server down) becomes a clear offline error. */
async function request(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch {
    throw new ApiError(
      'Server unavailable — the IndEV server is not responding. Start it with npm run dev, then try again.',
      'offline',
      0,
    );
  }
}

async function handle<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Request failed (${res.status})`;
    const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const code = typeof obj.code === 'string' ? obj.code : 'unknown';
    // Fine-grained not_determined cause when the server sent one
    // (e.g. 'budget-exhausted'): needed for cause-true UI guidance.
    const cause = typeof obj.cause === 'string' ? obj.cause : undefined;
    throw new ApiError(message, code, res.status, cause);
  }
  return body as T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    /** Fine-grained failure cause (not_determined) when the server sent one. */
    readonly cause?: string,
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
  aiPlan: (req: AiPlanRequest) => post<AiPlanResponse>('/api/ai/plan', req),
  trips: () => get<{ trips: SavedTrip[] }>('/api/trips'),
  trip: (id: string) => get<{ trip: SavedTrip }>(`/api/trips/${encodeURIComponent(id)}`),
  saveTrip: (plan: TripPlan, name?: string) => post<{ trip: SavedTrip }>('/api/trips', { plan, name }),
  deleteTrip: (id: string) => fetch(`/api/trips/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
