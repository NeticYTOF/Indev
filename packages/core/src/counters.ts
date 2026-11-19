/**
 * Running counters.
 *
 * The ONLY charger-related state the app persists is a running count of
 * chargers (stations) seen during planning runs - never any station data.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface CountersState {
  /** Cumulative unique stations examined live across all planning runs. */
  chargersSeen: number;
}

export class CountersStore {
  private readonly filePath: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(opts: { filePath: string }) {
    this.filePath = opts.filePath;
  }

  async load(): Promise<CountersState> {
    try {
      const text = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(text) as Partial<CountersState> | null;
      if (!parsed || typeof parsed !== 'object' ||
          !Number.isSafeInteger(parsed.chargersSeen) || (parsed.chargersSeen as number) < 0) {
        throw new Error('Counter file must contain a nonnegative safe integer chargersSeen');
      }
      return { chargersSeen: parsed.chargersSeen as number };
    } catch (err) {
      // Only a missing file is a new counter. Never overwrite existing
      // unreadable/corrupt history by pretending its value was zero.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { chargersSeen: 0 };
      throw err;
    }
  }

  /** Add this run's unique-seen count and persist atomically. */
  addChargersSeen(count: number): Promise<CountersState> {
    // Atomic rename alone does not protect a read-modify-write: overlapping
    // completed runs could read the same old count and lose increments.
    const update = async (): Promise<CountersState> => {
      const state = await this.load();
      state.chargersSeen += Math.max(0, Math.trunc(count));
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = join(dirname(this.filePath), `.tmp-${randomUUID()}.json`);
      await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
      await rename(tmp, this.filePath);
      return state;
    };
    const next = this.writeQueue.then(update, update);
    this.writeQueue = next.catch(() => {});
    return next;
  }
}

/** Counter telemetry must never erase or withhold an otherwise valid plan.
 * Keep write failures visible without claiming the count was persisted. */
export async function recordPlanCounter(
  store: CountersStore,
  plan: { stationsSeen: number; warnings: string[] },
): Promise<void> {
  try {
    await store.addChargersSeen(plan.stationsSeen);
  } catch {
    plan.warnings.push('Charger counter unavailable: this run was not added to the saved running count. The trip plan is still available.');
  }
}
