import { describe, expect, it, vi } from 'vitest';
import { resolveVehicle } from '@indeev/core';
import { runSelective } from '../src/selective-run.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

type Stage = [string, number, number, { ok: number; failed: number } | undefined];

function deps(geometry: Array<{ lat: number; lon: number }>, markers: () => Promise<never> | Promise<unknown>) {
  const gate = deferred<void>();
  const ai = vi.fn(async () => {
    await gate.promise;
    return { content: JSON.stringify({ chosenStationIds: [] }), toolCalls: [] };
  });
  return {
    gate,
    ai,
    run: {
      ai: { baseUrl: 'https://ai.test/v1', apiKey: 'test-key', model: 'test-model' },
      aiToolCall: ai,
      router: { route: async () => ({ distanceKm: geometry.length > 1 ? 20 : 0,
        durationMin: 24, geometry }) } as never,
      statiq: { markers } as never,
      origin: { label: 'A', lat: 0, lon: 0 },
      destination: { label: 'B', lat: geometry.length > 1 ? 0.18 : 0, lon: 0 },
      via: [], resolved: resolveVehicle(), planOptions: {},
      budget: { deadlineMs: 600_000, maxUpstreamCalls: 100 },
    },
  };
}

describe('discovery progress carries typed ok/failed counts', () => {
  it('forwards 2 ok and 1 failed while the AI turn is pending', async () => {
    const stages: Stage[] = [];
    let markers = 0;
    const d = deps(
      [{ lat: 0, lon: 0 }, { lat: 0.18, lon: 0 }],
      async () => {
        markers += 1;
        if (markers === 2) throw new Error('one sample unavailable');
        return { ok: true, live: true, retained: false, source: 'test',
          count: 0, stations: [] };
      },
    );
    const pending = runSelective({ ...d.run, onStage: (...args) => { stages.push(args); } });
    try {
      for (let i = 0; i < 20; i += 1) await tick();
      const discovery = stages.filter((s) => s[0] === 'discovery').at(-1);
      const shortlist = stages.find((s) => s[0] === 'shortlist');
      expect(discovery?.[3]).toEqual({ ok: 2, failed: 1 });
      expect(shortlist?.[3]).toEqual({ ok: 2, failed: 1 });
      expect(d.ai).toHaveBeenCalled();
      d.gate.resolve();
      const result = await pending;
      expect(result.diagnostics.samplesOk).toBe(2);
      expect(shortlist?.[2]).toBe(0);
      expect(result.diagnostics.unconfirmedReservations).toBe(0);
    } finally {
      d.gate.resolve();
      await pending.catch(() => {});
    }
  });

  it('reports zero counts honestly when there are no sample points', async () => {
    const stages: Stage[] = [];
    const d = deps([{ lat: 0, lon: 0 }], async () => ({ ok: true, live: true,
      retained: false, source: 'test', count: 0, stations: [] }));
    const pending = runSelective({ ...d.run, onStage: (...args) => { stages.push(args); } });
    try {
      for (let i = 0; i < 20; i += 1) await tick();
      expect(stages.find((s) => s[0] === 'shortlist')?.[3]).toEqual({ ok: 0, failed: 0 });
      d.gate.resolve();
      const result = await pending;
      expect(result.diagnostics.samplesPlanned).toBe(0);
      expect(result.diagnostics.samplesOk).toBe(0);
      expect(result.diagnostics.samplesFailed).toBe(0);
    } finally {
      d.gate.resolve();
      await pending.catch(() => {});
    }
  });
});
