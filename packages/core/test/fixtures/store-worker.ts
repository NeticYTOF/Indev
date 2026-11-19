import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { TripsStore } from '../../src/trips.js';
import { CountersStore } from '../../src/counters.js';
import { withStoreLock } from '../../src/store-lock.js';
import type { TripPlan } from '../../src/plan-types.js';

const [file = '', op = '', id = ''] = process.argv.slice(2);
const originalRename = fs.rename;
if (op === 'paused-save' || op === 'rejected-save') {
  fs.rename = async (...args) => {
    process.send?.({ event: 'rename-before' });
    await new Promise<void>((resolve) => process.once('message', () => resolve()));
    if (op === 'rejected-save') throw new Error('injected rename refusal');
    await originalRename(...args);
    process.send?.({ event: 'rename-after' });
    await new Promise<void>((resolve) => process.once('message', () => resolve()));
  };
  syncBuiltinESMExports();
}
process.send?.({ event: 'ready' });
process.once('message', async () => {
  process.send?.({ event: 'started' });
  try {
    let result: unknown;
    if (op === 'hold') {
      result = await withStoreLock(file, async () => {
        process.send?.({ event: 'acquired' });
        await new Promise<void>((resolve) => process.once('message', () => resolve()));
        return false;
      });
    } else if (op === 'increment') {
      result = await new CountersStore({ filePath: file }).addChargersSeen(Number(id));
    } else if (op === 'remove') {
      result = await new TripsStore({ filePath: file }).remove(id);
    } else {
      const plan = { id, origin: { label: 'A' }, destination: { label: 'B' }, geometry: [], stops: [], createdAt: '2026-11-19T00:00:00Z', totals: {}, vehicle: {} } as unknown as TripPlan;
      result = await new TripsStore({ filePath: file }).save(plan);
    }
    process.send?.({ event: 'result', ok: true, result });
  } catch (error) {
    process.send?.({ event: 'result', ok: false, error: (error as Error).message, code: (error as NodeJS.ErrnoException).code });
  } finally {
    fs.rename = originalRename;
    syncBuiltinESMExports();
    process.disconnect?.();
  }
});
