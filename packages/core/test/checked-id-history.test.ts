import { watch } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckedIdHistoryStore } from '../src/checked-id-history.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const dirs: string[] = [];
function store(name = 'history.json'): { filePath: string; history: CheckedIdHistoryStore } {
  const filePath = join(dirs[dirs.length - 1]!, name);
  return { filePath, history: new CheckedIdHistoryStore({ filePath }) };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('checked-ID history store', () => {
  it('stores sorted unique IDs under one active opaque scope with private mode', async () => {
    dirs.push(await mkdtemp(join(tmpdir(), 'indev-checked-history-')));
    const { filePath, history } = store();
    expect(await history.load(A)).toMatchObject({ status: 'absent', checkedIds: [] });
    expect(await history.record(A, [9, 2, 9, 5])).toMatchObject({ ok: true, added: 3 });
    expect(await history.load(A)).toMatchObject({ status: 'active', checkedIds: [2, 5, 9] });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 1, scopeKey: A, checkedIds: [2, 5, 9],
    });
  });

  it('replaces scope on load and refuses late old-scope writes', async () => {
    dirs.push(await mkdtemp(join(tmpdir(), 'indev-checked-history-')));
    const { history } = store();
    await history.load(A);
    await history.record(A, [1, 2]);
    expect(await history.load(B)).toMatchObject({ status: 'scope_changed', checkedIds: [] });
    expect(await history.record(A, [3])).toMatchObject({ ok: false, status: 'scope_changed', added: 0 });
    await history.record(B, [3]);
    expect(await history.load(B)).toMatchObject({ checkedIds: [3] });
  });

  it('unions same-scope concurrent writes atomically', async () => {
    dirs.push(await mkdtemp(join(tmpdir(), 'indev-checked-history-')));
    const { history } = store();
    await history.load(A);
    await Promise.all([history.record(A, [1, 2]), history.record(A, [2, 3])]);
    expect(await history.load(A)).toMatchObject({ status: 'active', checkedIds: [1, 2, 3] });
  });

  it('does not resurrect a missing target from a late old-scope writer', async () => {
    dirs.push(await mkdtemp(join(tmpdir(), 'indev-checked-history-')));
    const { filePath, history } = store();
    await history.load(A);
    await history.record(A, [1]);
    expect(await history.load(B)).toMatchObject({ status: 'scope_changed', checkedIds: [] });
    await unlink(filePath);
    expect(await history.record(A, [2])).toMatchObject({ ok: false, status: 'scope_changed', added: 0 });
    await expect(readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a committed write honestly when lock cleanup fails', async () => {
    dirs.push(await mkdtemp(join(tmpdir(), 'indev-checked-history-')));
    const { filePath, history } = store();
    await history.load(A);
    const lockPath = `${filePath}.lock`;
    const watcher = watch(dirs[dirs.length - 1]!, async (_event, name) => {
      if (name === basename(lockPath)) {
        try { await writeFile(join(lockPath, 'extra'), 'x'); } catch { /* timing race */ }
      }
    });
    const result = await history.record(A, [7]);
    watcher.close();
    expect(result).toMatchObject({ ok: true, status: 'saved_lock_cleanup_warning', added: 1 });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 1, scopeKey: A, checkedIds: [7],
    });
  });

  it('rejects extra fields, malformed schemas, aliases, and invalid IDs', async () => {
    dirs.push(await mkdtemp(join(tmpdir(), 'indev-checked-history-')));
    const { filePath, history } = store();
    await writeFile(filePath, JSON.stringify({ version: 1, scopeKey: A, checkedIds: [1], extra: 1 }));
    expect(await history.load(A)).toMatchObject({ status: 'invalid', checkedIds: [] });
    expect(await history.record(A, [2])).toMatchObject({ ok: false, status: 'unavailable' });
    await writeFile(filePath, JSON.stringify({ version: 1, scopeKey: A, checkedIds: [1] }));
    const alias = join(dirs[dirs.length - 1]!, 'alias.json');
    await symlink(filePath, alias);
    expect(await new CheckedIdHistoryStore({ filePath: alias }).load(A))
      .toMatchObject({ status: 'unavailable', checkedIds: [] });
    expect(await history.record(A, [-1])).toMatchObject({ ok: false, status: 'unavailable' });
  });
});
