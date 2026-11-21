import { describe, expect, it, vi } from 'vitest';
import type { RunProgressStats } from '@indeev/core';
import { PlanJobRegistry, type PlanJobControls } from '../src/plan-job.js';
import { SingleRunSlot } from '../src/run-slot.js';

const BUDGET = { deadlineMs: 600_000, maxUpstreamCalls: 600 };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeRegistry(
  run: (controls: PlanJobControls) => Promise<unknown>,
  maxRetained = 20,
) {
  const slot = new SingleRunSlot();
  const registry = new PlanJobRegistry(run, {
    maxActive: 1, budget: BUDGET, maxRetained, acquire: () => slot.acquire(),
  });
  return { registry, slot };
}

const partial: RunProgressStats = {
  samplesPlanned: 10, samplesCompleted: 3, samplesOk: 3, samplesFailed: 0,
  candidatesPlanned: 0, candidatesProcessed: 0, candidatesDetailed: 0,
  candidateInventoryComplete: false, scanMs: 0, detailsStartedAt: null,
};

describe('process-local plan jobs', () => {
  it('admits one run at a time and releases only after the run settles', async () => {
    const gate = deferred<string>();
    const { registry } = makeRegistry(() => gate.promise);
    const first = registry.start(undefined);
    expect(first.ok).toBe(true);
    expect(registry.start(undefined)).toEqual({ ok: false, code: 'job_capacity' });
    gate.resolve('done');
    await tick();
    expect(registry.start(undefined).ok).toBe(true);
  });

  it('status polling is a pure snapshot and makes zero run calls', async () => {
    const running = deferred<PlanJobControls>();
    const gate = deferred<string>();
    let runs = 0;
    const { registry } = makeRegistry(async (controls) => {
      runs += 1;
      running.resolve(controls);
      return gate.promise;
    });
    const started = registry.start(undefined);
    if (!started.ok) throw new Error('start refused');
    const controls = await running.promise;
    controls.onProgress?.(partial);
    for (let i = 0; i < 5; i += 1) {
      expect(registry.status(started.jobId, started.capability)?.progress?.samplesCompleted).toBe(3);
    }
    expect(runs).toBe(1);
    expect(registry.status(started.jobId, started.capability)?.state).toBe('running');
    gate.resolve('plan');
    await tick();
    expect(registry.status(started.jobId, started.capability)?.result).toBe('plan');
    expect(runs).toBe(1);
  });

  it('cancel is terminal, aborts the run, and keeps capacity until actual settle', async () => {
    const running = deferred<PlanJobControls>();
    const gate = deferred<string>();
    let aborted = false;
    const { registry } = makeRegistry(async (controls) => {
      controls.signal?.addEventListener('abort', () => { aborted = true; });
      running.resolve(controls);
      return gate.promise;
    });
    const started = registry.start(undefined);
    if (!started.ok) throw new Error('start refused');
    await running.promise;
    expect(registry.cancel(started.jobId, started.capability)).toBe(true);
    expect(aborted).toBe(true);
    expect(registry.status(started.jobId, started.capability)?.state).toBe('cancelled');
    // Cancel marked terminal but the run has not unwound: slot stays busy.
    expect(registry.start(undefined)).toEqual({ ok: false, code: 'job_capacity' });
    gate.resolve('late');
    await tick();
    expect(registry.status(started.jobId, started.capability)?.state).toBe('cancelled');
    expect(registry.status(started.jobId, started.capability)?.result).toBeUndefined();
    expect(registry.start(undefined).ok).toBe(true);
  });

  it('does not disclose or cancel a job without its capability', async () => {
    const gate = deferred<string>();
    const { registry } = makeRegistry(() => gate.promise);
    const started = registry.start(undefined);
    if (!started.ok) throw new Error('start refused');
    expect(registry.status(started.jobId, undefined)).toBeUndefined();
    expect(registry.status(started.jobId, 'guess')).toBeUndefined();
    expect(registry.cancel(started.jobId, undefined)).toBe(false);
    expect(registry.cancel('other-id', started.capability)).toBe(false);
    gate.resolve('done');
    await tick();
  });

  it('a restarted registry has no memory and terminal records are pruned', async () => {
    const { registry } = makeRegistry(async () => 'ok', 1);
    const first = registry.start(undefined);
    if (!first.ok) throw new Error('start refused');
    await tick();
    const second = registry.start(undefined);
    if (!second.ok) throw new Error('start refused');
    await tick();
    expect(registry.status(first.jobId, first.capability)).toBeUndefined();
    expect(registry.status(second.jobId, second.capability)?.state).toBe('succeeded');
    expect(new SingleRunSlot().occupied).toBe(false);
  });

  it('wall deadline records failure; a late abort-ignoring resolve cannot succeed', async () => {
    vi.useFakeTimers();
    try {
      const gate = deferred<string>();
      const slot = new SingleRunSlot();
      const registry = new PlanJobRegistry(() => gate.promise, {
        maxActive: 1,
        budget: { deadlineMs: 20, maxUpstreamCalls: 600 },
        acquire: () => slot.acquire(),
      });
      const started = registry.start(undefined);
      if (!started.ok) throw new Error('start refused');
      await vi.advanceTimersByTimeAsync(21);
      expect(registry.status(started.jobId, started.capability)?.state).toBe('failed');
      expect(registry.status(started.jobId, started.capability)?.error?.code).toBe('job_deadline');
      gate.resolve('late');
      await Promise.resolve();
      await Promise.resolve();
      expect(registry.status(started.jobId, started.capability)?.state).toBe('failed');
      expect(registry.status(started.jobId, started.capability)?.result).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
});
