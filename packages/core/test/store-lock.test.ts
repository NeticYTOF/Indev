import fs from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreLockCleanupError, withStoreLock } from '../src/store-lock.js';
import { CountersStore, recordPlanCounter } from '../src/counters.js';

const roots: string[] = [];
const children: ChildProcess[] = [];
async function temp() { const root = await fs.mkdtemp(join(tmpdir(), 'indev-lock-')); roots.push(root); return root; }
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.kill('SIGKILL'); await closed;
  }));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
type Event = { event: string; ok?: boolean; code?: string; result?: unknown };
function worker(file: string, op: string, id = '') {
  const child = spawn(process.execPath, ['--import', 'tsx', resolve(import.meta.dirname, 'fixtures/store-worker.ts'), file, op, id], {
    cwd: resolve(import.meta.dirname, '../../..'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  const events: Event[] = [];
  const listeners = new Set<(event: Event) => void>();
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  child.on('message', message => { const e = message as Event; events.push(e); for (const listener of listeners) listener(e); });
  const wait = (event: string) => new Promise<Event>((resolve, reject) => {
    const existing = events.find(e => e.event === event); if (existing) return resolve(existing);
    const timeout = setTimeout(() => reject(new Error(`Worker ${event} timeout: ${stderr}`)), 12_000);
    const listener = (e: Event) => { if (e.event === event) { clearTimeout(timeout); listeners.delete(listener); resolve(e); } };
    listeners.add(listener);
  });
  return { child, events, wait, start: () => child.send({ continue: true }) };
}
async function pair(file: string, a: [string, string], b: [string, string]) {
  const one = worker(file, ...a), two = worker(file, ...b);
  await Promise.all([one.wait('ready'), two.wait('ready')]); one.start(); two.start();
  const result = await Promise.all([one.wait('result'), two.wait('result')]);
  expect(result.every(r => r.ok)).toBe(true);
}

describe('process-safe local JSON writers', () => {
  it('retains actual-process save/save, save/remove and increments', async () => {
    const root = await temp(); const file = join(root, 'trips.json');
    await pair(file, ['save', 'A'], ['save', 'B']);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toHaveLength(2);
    await pair(file, ['remove', 'A'], ['save', 'C']);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).map((t: {id:string}) => t.id).sort()).toEqual(['B', 'C']);
    const counter = join(root, 'counter.json');
    await pair(counter, ['increment', '3'], ['increment', '4']);
    expect(JSON.parse(await fs.readFile(counter, 'utf8')).chargersSeen).toBe(7);
  });

  it.each(['paused-save', 'rejected-save'])('excludes a real competing writer through %s rename settlement', async op => {
    const root = await temp(); const file = join(root, 'trips.json'); await fs.writeFile(file, '[]');
    const first = worker(file, op, 'A'); await first.wait('ready'); first.start(); await first.wait('rename-before');
    const second = worker(file, 'save', 'B'); await second.wait('ready'); second.start(); await second.wait('started');
    await sleep(100); expect(second.events.some(e => e.event === 'result')).toBe(false);
    expect(await fs.readFile(file, 'utf8')).toBe('[]'); await fs.access(file + '.lock/owner');
    first.start();
    if (op === 'paused-save') {
      await first.wait('rename-after'); await sleep(100);
      expect(second.events.some(e => e.event === 'result')).toBe(false);
      expect(JSON.parse(await fs.readFile(file, 'utf8')).map((t:{id:string}) => t.id)).toEqual(['A']);
      await fs.access(file + '.lock/owner'); first.start();
    }
    expect((await first.wait('result')).ok).toBe(op === 'paused-save');
    expect((await second.wait('result')).ok).toBe(true);
    const ids = JSON.parse(await fs.readFile(file, 'utf8')).map((t:{id:string}) => t.id).sort();
    expect(ids).toEqual(op === 'paused-save' ? ['A', 'B'] : ['B']);
  });

  it('refuses an abandoned lock after five seconds without running a body or taking over', async () => {
    const root = await temp(); const file = join(root, 'trips.json'); await fs.writeFile(file, '[]');
    const holder = worker(file, 'hold'); await holder.wait('ready'); holder.start(); await holder.wait('acquired');
    const closed = new Promise<void>(resolve => holder.child.once('close', () => resolve())); holder.child.kill('SIGKILL'); await closed;
    const token = await fs.readFile(file + '.lock/owner', 'utf8');
    const follower = worker(file, 'save', 'B'); await follower.wait('ready'); const started = performance.now(); follower.start();
    expect((await follower.wait('result')).code).toBe('STORE_LOCK_BUSY');
    expect(performance.now() - started).toBeGreaterThanOrEqual(4_950);
    expect(await fs.readFile(file, 'utf8')).toBe('[]'); expect(await fs.readFile(file + '.lock/owner', 'utf8')).toBe(token);
  }, 15_000);

  it('keeps separate mock paths independent and shares canonical parent aliases', async () => {
    const root = await temp(); const actual = join(root, 'actual'), alias = join(root, 'alias'); await fs.mkdir(actual); await fs.symlink(actual, alias, 'dir');
    const first = worker(join(actual, 'trips.json'), 'hold'); await first.wait('ready'); first.start(); await first.wait('acquired');
    const blocked = worker(join(alias, 'trips.json'), 'save', 'A'); const mock = worker(join(actual, 'trips.mock.json'), 'save', 'M');
    await Promise.all([blocked.wait('ready'), mock.wait('ready')]); blocked.start(); mock.start();
    expect((await mock.wait('result')).ok).toBe(true); expect(blocked.events.some(e => e.event === 'result')).toBe(false);
    first.start(); expect((await first.wait('result')).ok).toBe(true); expect((await blocked.wait('result')).ok).toBe(true);
  });

  it('rejects symlink, hardlink and directory targets without altering them', async () => {
    const root = await temp(); const file = join(root, 'target'); await fs.writeFile(file, 'original');
    const sym = join(root, 'sym'), hard = join(root, 'hard'), dir = join(root, 'dir'); await fs.symlink(file, sym); await fs.link(file, hard); await fs.mkdir(dir);
    for (const target of [sym, hard, dir]) { const body = vi.fn(); await expect(withStoreLock(target, body)).rejects.toThrow('regular file'); expect(body).not.toHaveBeenCalled(); await expect(fs.access(target + '.lock')).rejects.toThrow(); }
    expect(await fs.readFile(file, 'utf8')).toBe('original');
  });

  it('distinguishes no-op completion from a committed write on cleanup failure', async () => {
    const root = await temp(); const file = join(root, 'counter.json');
    const realRmdir = fs.rmdir.bind(fs);
    const spy = vi.spyOn(fs, 'rmdir').mockImplementation(async (...args) => { if (String(args[0]).endsWith('.lock')) throw new Error('injected cleanup refusal'); return realRmdir(...args); });
    const error = await withStoreLock(file, async () => false).catch(e => e);
    expect(error).toBeInstanceOf(StoreLockCleanupError); expect(error.result).toBe(false); expect(error.committed).toBe(false);
    spy.mockRestore(); await fs.rm(file + '.lock', { recursive: true });
    vi.spyOn(fs, 'rmdir').mockRejectedValue(new Error('injected cleanup refusal'));
    const plan = { stationsSeen: 7, warnings: [] as string[] }; const store = new CountersStore({ filePath: file });
    const add = vi.spyOn(store, 'addChargersSeen'); await recordPlanCounter(store, plan);
    expect((await store.load()).chargersSeen).toBe(7); expect(add).toHaveBeenCalledTimes(1);
    expect(plan.warnings.join(' ')).toContain('persistence could not be confirmed'); expect(plan.warnings.join(' ')).not.toContain('was not added');
    vi.restoreAllMocks(); await fs.rm(file + '.lock', { recursive: true });
    expect((await store.addChargersSeen(2)).chargersSeen).toBe(9);
  });

  it('removes only its own empty directory after failed token initialization', async () => {
    const root = await temp(); const file = join(root, 's.json');
    const original = fs.writeFile.bind(fs);
    const body = vi.fn(async () => 42);
    const spy = vi.spyOn(fs, 'writeFile').mockRejectedValue(new Error('injected init failure'));
    await expect(withStoreLock(file, body)).rejects.toThrow('init failure');
    expect(body).not.toHaveBeenCalled(); await expect(fs.access(file + '.lock')).rejects.toThrow();
    spy.mockImplementation(async (...args) => { await original(...args); throw new Error('partial init failure'); });
    await expect(withStoreLock(file, body)).rejects.toThrow('partial init failure');
    expect(body).not.toHaveBeenCalled(); expect(await fs.readFile(file + '.lock/owner', 'utf8')).not.toBe('');
  });

  it('keeps both errors when the body throws and cleanup also fails', async () => {
    const root = await temp(); const file = join(root, 's.json'); const bodyError = new Error('injected body failure');
    vi.spyOn(fs, 'rmdir').mockRejectedValue(new Error('injected cleanup failure'));
    const error = await withStoreLock(file, async () => { throw bodyError; }).catch(e => e);
    expect(error).toBeInstanceOf(AggregateError); expect(error.errors[0]).toBe(bodyError);
    expect(error.errors[1].message).toContain('cleanup failure');
  });

  it('preserves mismatched ownership and releases after a thrown body', async () => {
    const root = await temp(); const file = join(root, 's.json'); const original = new Error('body failed');
    await expect(withStoreLock(file, async () => { throw original; })).rejects.toBe(original);
    await expect(fs.access(file + '.lock')).rejects.toThrow();
    const error = await withStoreLock(file, async () => { await fs.writeFile(file + '.lock/owner', 'other-owner'); return 42; }).catch(e => e);
    expect(error).toBeInstanceOf(StoreLockCleanupError); expect(error.result).toBe(42); expect(error.committed).toBe(false);
    expect(await fs.readFile(file + '.lock/owner', 'utf8')).toBe('other-owner');
  });
});
