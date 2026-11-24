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
import type { TripPlan } from './plan-types.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withStoreLock } from './store-lock.js';
import { toSavedTrip, type SavedTrip } from './trip-shape.js';

export * from './trip-shape.js';

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
