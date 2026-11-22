/** IDs-only run history. No status, charger facts, timestamps, prompts, or labels. */
import { chmod, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StoreLockCleanupError, STORE_LOCK_CLEANUP_WARNING, withStoreLock } from './store-lock.js';

export interface CheckedIdHistoryState {
  version: 1;
  scopeKey: string;
  checkedIds: number[];
}
export type CheckedIdHistoryStatus =
  | 'active' | 'absent' | 'invalid' | 'scope_changed'
  | 'saved' | 'save_failed' | 'unavailable' | 'saved_lock_cleanup_warning';
export interface CheckedIdHistoryLoad {
  status: CheckedIdHistoryStatus;
  checkedIds: readonly number[];
  warning?: string;
}
export interface CheckedIdHistoryWrite {
  ok: boolean;
  status: CheckedIdHistoryStatus;
  added: number;
  warning?: string;
}
export interface CheckedIdHistoryStoreOptions {
  filePath: string;
  maxIds?: number;
  maxBytes?: number;
}

const SCOPE_KEY = /^[0-9a-f]{64}$/;
const PRIVATE_MODE = 0o600;

function validId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function parseState(raw: Buffer): { ok: true; state: CheckedIdHistoryState } | { ok: false } {
  let parsed: unknown;
  try {
    if (raw.byteLength === 0 || raw.byteLength > 16_384) return { ok: false };
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return { ok: false };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
  if (Object.keys(parsed).sort().join(',') !== 'checkedIds,scopeKey,version') return { ok: false };
  if (!('version' in parsed) || parsed.version !== 1) return { ok: false };
  if (!('scopeKey' in parsed) || typeof parsed.scopeKey !== 'string' ||
      !SCOPE_KEY.test(parsed.scopeKey)) return { ok: false };
  if (!('checkedIds' in parsed) || !Array.isArray(parsed.checkedIds)) return { ok: false };
  const checkedIds: number[] = [];
  let previous = 0;
  for (const id of parsed.checkedIds) {
    if (!validId(id) || id <= previous) return { ok: false };
    checkedIds.push(id);
    previous = id;
  }
  return { ok: true, state: { version: 1, scopeKey: parsed.scopeKey, checkedIds } };
}
function serialized(state: CheckedIdHistoryState): string {
  return JSON.stringify(state);
}
function isWriteResult(value: unknown): value is CheckedIdHistoryWrite {
  return value !== null && typeof value === 'object' &&
    'ok' in value && typeof value.ok === 'boolean' &&
    'status' in value && typeof value.status === 'string' &&
    'added' in value && typeof value.added === 'number';
}
function committedWrite(error: unknown): CheckedIdHistoryWrite | null {
  if (error instanceof StoreLockCleanupError && error.committed && isWriteResult(error.result)) {
    return { ...error.result, status: 'saved_lock_cleanup_warning',
      warning: STORE_LOCK_CLEANUP_WARNING };
  }
  return null;
}
function committedLoad(error: unknown): CheckedIdHistoryLoad | null {
  if (error instanceof StoreLockCleanupError && error.committed &&
      error.result !== null && typeof error.result === 'object' &&
      'status' in error.result && 'checkedIds' in error.result) {
    return { status: 'saved_lock_cleanup_warning', checkedIds: [],
      warning: STORE_LOCK_CLEANUP_WARNING };
  }
  return null;
}

export class CheckedIdHistoryStore {
  private readonly filePath: string;
  private readonly maxIds: number;
  private readonly maxBytes: number;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(opts: CheckedIdHistoryStoreOptions) {
    this.filePath = opts.filePath;
    this.maxIds = opts.maxIds ?? 400;
    this.maxBytes = opts.maxBytes ?? 16_384;
  }

  private async read(filePath: string): Promise<
    { ok: true; state: CheckedIdHistoryState } | { ok: false; absent: boolean }
  > {
    try {
      const stat = await lstat(filePath);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > this.maxBytes) return { ok: false, absent: false };
      const parsed = parseState(await readFile(filePath));
      if (!parsed.ok || parsed.state.checkedIds.length > this.maxIds) return { ok: false, absent: false };
      return parsed;
    } catch (err) {
      if (err !== null && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        return { ok: false, absent: true };
      }
      return { ok: false, absent: false };
    }
  }

  private async write(filePath: string, state: CheckedIdHistoryState): Promise<boolean> {
    const text = serialized(state);
    if (Buffer.byteLength(text, 'utf8') > this.maxBytes) return false;
    const tmp = join(dirname(filePath), `.tmp-${randomUUID()}.json`);
    try {
      await writeFile(tmp, text, { encoding: 'utf8', mode: PRIVATE_MODE });
      await chmod(tmp, PRIVATE_MODE);
      await rename(tmp, filePath);
      return true;
    } catch {
      try { await unlink(tmp); } catch { /* advisory cleanup only */ }
      return false;
    }
  }

  async load(scopeKey: string): Promise<CheckedIdHistoryLoad> {
    if (typeof scopeKey !== 'string' || !SCOPE_KEY.test(scopeKey)) {
      return { status: 'unavailable', checkedIds: [] };
    }
    try {
      return await withStoreLock(this.filePath, async (canonical, markCommitted) => {
        const current = await this.read(canonical);
        if (!current.ok) {
          if (!current.absent) return { status: 'invalid', checkedIds: [] };
          const fresh: CheckedIdHistoryState = { version: 1, scopeKey, checkedIds: [] };
          if (!await this.write(canonical, fresh)) return { status: 'unavailable', checkedIds: [] };
          markCommitted();
          return { status: 'absent', checkedIds: [] };
        }
        if (current.state.scopeKey !== scopeKey) {
          const fresh: CheckedIdHistoryState = { version: 1, scopeKey, checkedIds: [] };
          if (!await this.write(canonical, fresh)) return { status: 'unavailable', checkedIds: [] };
          markCommitted();
          return { status: 'scope_changed', checkedIds: [] };
        }
        return { status: 'active', checkedIds: [...current.state.checkedIds] };
      });
    } catch (err) {
      return committedLoad(err) ?? { status: 'unavailable', checkedIds: [] };
    }
  }

  record(scopeKey: string, ids: readonly number[]): Promise<CheckedIdHistoryWrite> {
    if (typeof scopeKey !== 'string' || !SCOPE_KEY.test(scopeKey) ||
        !Array.isArray(ids) || !ids.every(validId)) {
      return Promise.resolve({ ok: false, status: 'unavailable', added: 0 });
    }
    const incoming = [...new Set(ids)].sort((a, b) => a - b);
    if (incoming.length === 0) return Promise.resolve({ ok: true, status: 'saved', added: 0 });
    const update = (): Promise<CheckedIdHistoryWrite> => withStoreLock(this.filePath,
      async (canonical, markCommitted) => {
        const current = await this.read(canonical);
        if (!current.ok) {
          return { ok: false, status: current.absent ? 'scope_changed' : 'unavailable', added: 0 };
        }
        if (current.state.scopeKey !== scopeKey) {
          return { ok: false, status: 'scope_changed', added: 0 };
        }
        const union = [...new Set([...current.state.checkedIds, ...incoming])].sort((a, b) => a - b);
        if (union.length > this.maxIds) return { ok: false, status: 'unavailable', added: 0 };
        const added = union.length - current.state.checkedIds.length;
        if (added === 0) return { ok: true, status: 'saved', added: 0 };
        if (!await this.write(canonical, { version: 1, scopeKey, checkedIds: union })) {
          return { ok: false, status: 'unavailable', added: 0 };
        }
        markCommitted();
        return { ok: true, status: 'saved', added };
      });
    const next = this.writeQueue.then(update, update);
    this.writeQueue = next.catch(() => {});
    return next.catch((err) => committedWrite(err) ??
      ({ ok: false, status: 'unavailable', added: 0 }));
  }
}
