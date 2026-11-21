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
  /** Hard cap for selected charger rated power; omitted means no cap. */
  maxChargerKw?: number;
}

export interface AiPlanRequest extends PlanRequest {
  /** Plain-text custom requests from the AI box (e.g. "prefer food stops"). */
  request?: string;
}

export interface AiPlanResponse {
  plan: TripPlan;
  ai: { applied: boolean; notes?: string; reason?: string };
}

/** Start response. The capability is a one-shot bearer secret: the caller
 *  holds it only in memory for this page session, never in storage or URLs. */
export interface PlanJobStart {
  jobId: string;
  capability: string;
  budget: { deadlineMs: number; maxUpstreamCalls: number };
}

export interface PlanJobStatus {
  jobId: string;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt: number | null;
  /** Advisory only: candidatesPlanned=0 with candidateInventoryComplete=false
   *  means the scan has not returned; never present it as an empty pool. */
  progress: {
    samplesPlanned: number;
    samplesCompleted: number;
    samplesOk: number;
    samplesFailed: number;
    candidatesPlanned: number;
    candidatesProcessed: number;
    candidatesDetailed: number;
    candidateInventoryComplete: boolean;
  } | null;
  result?: AiPlanResponse;
  error?: { code: string; message: string; cause?: string };
}

async function get<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await request(path, init);
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

function requireEnvelope<T>(body: T | null, label: string): T {
  if (body == null || typeof body !== 'object') {
    throw new ApiError('The route response was malformed. Please try again.', 'malformed_plan', 200);
  }
  if (!('plan' in (body as Record<string, unknown>)) || (body as Record<string, unknown>).plan == null) {
    throw new ApiError(`The ${label} response did not include a route. Please try again.`, 'malformed_plan', 200);
  }
  return body;
}

export const api = {
  health: () => get<HealthInfo>('/api/health'),
  vehicles: () =>
    get<{ default: string; catalog: VehicleCatalogEntry[]; note: string }>('/api/vehicles'),
  geocode: (q: string) => get<{ hits: GeocodeHit[] }>(`/api/geocode?q=${encodeURIComponent(q)}`),
  plan: async (req: PlanRequest) => requireEnvelope(await post<{ plan: TripPlan } | null>('/api/plan', req), 'planning'),
  aiPlan: async (req: AiPlanRequest) => requireEnvelope(await post<AiPlanResponse | null>('/api/ai/plan', req), 'AI planning'),
  // Capability is passed by the caller from in-memory state only; never
  // persisted, logged, or placed in a URL.
  startPlanJob: (req: AiPlanRequest) => post<PlanJobStart>('/api/jobs/plan', req),
  planJobStatus: (jobId: string, capability: string) =>
    get<PlanJobStatus>(`/api/jobs/plan/${encodeURIComponent(jobId)}`, {
      headers: { 'x-job-capability': capability },
    }),
  cancelPlanJob: async (jobId: string, capability: string) => {
    const res = await request(`/api/jobs/plan/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
      headers: { 'x-job-capability': capability },
    });
    return await handle<{ cancelled: boolean }>(res);
  },
  trips: () => get<{ trips: SavedTrip[] }>('/api/trips'),
  trip: (id: string) => get<{ trip: SavedTrip }>(`/api/trips/${encodeURIComponent(id)}`),
  saveTrip: (plan: TripPlan, name?: string) => post<{ trip: SavedTrip; warnings?: unknown }>('/api/trips', { plan, name }),
  deleteTrip: (id: string) => fetch(`/api/trips/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
