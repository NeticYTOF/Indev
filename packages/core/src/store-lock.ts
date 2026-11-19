import fs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

export const STORE_LOCK_CLEANUP_WARNING = 'Storage operation completed, but its writer lock could not be released. Do not retry the operation; stop all writers before manual recovery.';

export class StoreLockBusyError extends Error {
  readonly code = 'STORE_LOCK_BUSY';
  constructor() {
    super('Store writer lock busy. No write was attempted. Stop all writers before checking for an abandoned lock.');
    this.name = 'StoreLockBusyError';
  }
}

/** The body completed, including a possible no-op. Never retry automatically. */
export class StoreLockCleanupError<T = unknown> extends Error {
  readonly operationCompleted = true;
  readonly code = 'STORE_LOCK_CLEANUP_FAILED';
  constructor(readonly result: T, readonly committed: boolean, cause: unknown) {
    super(STORE_LOCK_CLEANUP_WARNING, { cause });
    this.name = 'StoreLockCleanupError';
  }
}

async function validateTarget(filePath: string): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error('Store target must be a regular file without symlink or hardlink aliases');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Local cooperative writers only. No stale takeover, even after a crash.
 * All old writers must be stopped before deployment. Manual recovery is an
 * offline operation, never safe while any writer can still be running.
 * Parent aliases are canonicalized; target aliases are refused. Stable paths
 * are required, not protection against hostile local filesystem mutation.
 */
export async function withStoreLock<T>(
  filePath: string,
  body: (canonicalPath: string, markCommitted: () => void) => Promise<T>,
): Promise<T> {
  await validateTarget(filePath);
  await fs.mkdir(dirname(filePath), { recursive: true });
  const canonicalPath = join(await fs.realpath(dirname(filePath)), basename(filePath));
  await validateTarget(canonicalPath);
  const lockPath = `${canonicalPath}.lock`;
  const ownerPath = join(lockPath, 'owner');
  const token = randomUUID();
  const deadline = performance.now() + 5_000;
  let contended = false;
  for (;;) {
    if (contended && performance.now() >= deadline) {
      throw new StoreLockBusyError();
    }
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      contended = true;
      await sleep(Math.min(25 + Math.random() * 25, Math.max(1, deadline - performance.now())));
    }
  }
  try {
    await fs.writeFile(ownerPath, token, { flag: 'wx' });
  } catch (error) {
    // Only our freshly acquired empty directory can be removed. Never recurse.
    try { await fs.rmdir(lockPath); } catch { /* Preserve partial initialization. */ }
    throw error;
  }

  let result!: T;
  let committed = false;
  let completed = false;
  let bodyError: unknown;
  let cleanupError: unknown;
  try {
    await validateTarget(canonicalPath);
    result = await body(canonicalPath, () => { committed = true; });
    completed = true;
  } catch (error) {
    bodyError = error;
  } finally {
    try {
      if (await fs.readFile(ownerPath, 'utf8') !== token) throw new Error('Store lock ownership changed; refusing cleanup');
      await fs.unlink(ownerPath);
      await fs.rmdir(lockPath);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (!completed) {
    if (cleanupError) throw new AggregateError([bodyError, cleanupError], 'Store operation failed and its writer lock could not be released');
    throw bodyError;
  }
  if (cleanupError) throw new StoreLockCleanupError(result, committed, cleanupError);
  return result;
}
