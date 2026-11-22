/**
 * Saved trips store.
 *
 * Shared by the web app (via the HTTP server) and the MCP server, so both
 * surfaces see the same trips. A saved plan stores ONLY minimal station
 * references plus route geometry - never full station data. Chargers are
 * always re-fetched live when a trip is viewed.
 *
 * Storage: a JSON file with atomic writes (write temp + rename) and a
 * serialized write queue to avoid interleaved writes.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withStoreLock } from './store-lock.js';
import type { TripPlan } from './plan-types.js';

/** Minimal station reference kept in a saved trip. */
export interface SavedStationRef {
  stationId: number;
  name: string;
  lat: number;
  lon: number;
  chainageKm: number;
  legKm: number;
  detourKm: number;
  arriveSocPct: number;
  leaveSocPct: number;
  chargeKwh: number;
  pricePerKwh: number | null;
  estPriceInr: number | null;
  chargeTimeMin: number;
  /** Plan-derived minutes from trip start; absent in older saved records. */
  arrivalEtaMin?: number;
  departureEtaMin?: number;
}

export interface SavedTrip {
  id: string;
  name: string;
  createdAt: string;
  origin: { label: string; lat: number; lon: number };
  destination: { label: string; lat: number; lon: number };
  /** Ordered user stopovers; copied only when non-empty. */
  via?: TripPlan['via'];
  vehicle: TripPlan['vehicle'];
  /** Validated starting charge from the originating plan, when available. */
  startSocPct?: number;
  /** Scan integrity at planning time (degraded plans show visible holes). */
  status: TripPlan['status'];
  /** Provenance: live vs synthetic; synthetic trips never enter the live store. */
  source: TripPlan['source'];
  routeDistanceKm: number;
  routeDurationMin: number;
  /** Route geometry: [lat, lon] pairs, kept so the map can redraw the path. */
  geometry: [number, number][];
  stations: SavedStationRef[];
  totals: TripPlan['totals'];
}

function savedSoc(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value : undefined;
}
function savedEta(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Reduce a live plan to the minimal saved form (no station detail data). */
export function toSavedTrip(plan: TripPlan, name?: string): SavedTrip {
  const startSocPct = savedSoc(plan.startSocPct);
  return {
    id: plan.id || randomUUID(),
    name: name?.trim() || tripName(plan),
    createdAt: plan.createdAt,
    origin: plan.origin,
    destination: plan.destination,
    ...(plan.via?.length ? { via: plan.via.map(place => ({ label: place.label, lat: place.lat, lon: place.lon })) } : {}),
    vehicle: plan.vehicle,
    ...(startSocPct !== undefined ? { startSocPct } : {}),
    status: plan.status,
    source: plan.source,
    routeDistanceKm: plan.routeDistanceKm,
    routeDurationMin: plan.routeDurationMin,
    geometry: plan.geometry.map((p) => [p.lat, p.lon] as [number, number]),
    stations: plan.stops.map((s) => {
      const arrivalEtaMin = savedEta(s.arrivalEtaMin);
      const departureEtaMin = savedEta(s.departureEtaMin);
      return {
        stationId: s.station.stationId,
        name: s.station.name,
        lat: s.station.lat,
        lon: s.station.lon,
        chainageKm: s.chainageKm,
        legKm: s.legKm,
        detourKm: s.detourKm,
        arriveSocPct: s.arriveSocPct,
        leaveSocPct: s.leaveSocPct,
        chargeKwh: s.chargeKwh,
        pricePerKwh: s.pricePerKwh,
        estPriceInr: s.estPriceInr,
        chargeTimeMin: s.chargeTimeMin,
        ...(arrivalEtaMin !== undefined ? { arrivalEtaMin } : {}),
        ...(departureEtaMin !== undefined ? { departureEtaMin } : {}),
      };
    }),
    totals: plan.totals,
  };
}

function tripName(plan: TripPlan): string {
  const date = new Date(plan.createdAt);
  return `${plan.origin.label} → ${plan.destination.label} (${date.toLocaleDateString('en-IN')})`;
}

export interface TripsStoreOptions {
  /** File path for the saved trips JSON. */
  filePath: string;
}

export class TripsStore {
  private readonly filePath: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(opts: TripsStoreOptions) {
    this.filePath = opts.filePath;
  }

  private async readAllRaw(filePath = this.filePath): Promise<SavedTrip[]> {
    try {
      const text = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('Saved trips file must contain an array');
      return parsed as SavedTrip[];
    } catch (err) {
      // A missing file is a new store. Any other failure must stop writes:
      // treating corrupted or unreadable data as empty would overwrite it
      // on the next save, destroying trips the user could still recover.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      throw err;
    }
  }

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(op, op);
    this.writeQueue = next.catch(() => {});
    return next;
  }

  /** Atomic write: temp file in the same directory, then rename. */
  private async writeAll(filePath: string, trips: SavedTrip[]): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = join(dirname(filePath), `.tmp-${randomUUID()}.json`);
    await writeFile(tmp, JSON.stringify(trips, null, 2), 'utf8');
    await rename(tmp, filePath);
  }

  list(): Promise<SavedTrip[]> {
    return this.readAllRaw();
  }

  async get(id: string): Promise<SavedTrip | null> {
    const trips = await this.readAllRaw();
    return trips.find((t) => t.id === id) ?? null;
  }

  /** Save a plan (minimal form). Returns the saved trip. */
  async save(plan: TripPlan, name?: string): Promise<SavedTrip> {
    return this.serialize(() => withStoreLock(this.filePath, async (filePath, markCommitted) => {
      const trips = await this.readAllRaw(filePath);
      const saved = toSavedTrip(plan, name);
      const idx = trips.findIndex((t) => t.id === saved.id);
      if (idx >= 0) {
        trips[idx] = saved;
      } else {
        trips.unshift(saved);
      }
      await this.writeAll(filePath, trips);
      markCommitted();
      return saved;
    }));
  }

  async remove(id: string): Promise<boolean> {
    return this.serialize(() => withStoreLock(this.filePath, async (filePath, markCommitted) => {
      const trips = await this.readAllRaw(filePath);
      const next = trips.filter((t) => t.id !== id);
      if (next.length === trips.length) return false;
      await this.writeAll(filePath, next);
      markCommitted();
      return true;
    }));
  }
}
