/**
 * Environment contamination guarantees (live/AI-off by construction).
 *
 * Linux review of 23e6d03 (gap 2): the acceptance runner's live child
 * deleted INDEV_MOCK / AI_* keys, so the child's loadEnv could then fill
 * them FROM THE REPO .ENV - flipping a "live" acceptance run to mock or
 * silently enabling the AI planner. The mode gate caught mock afterwards,
 * but AI-on was unguarded.
 *
 * By construction now: buildChildEnv('live') PINS INDEV_MOCK='0' and
 * AI_*='' (presence-pinned empty), and loadEnv's .env fills only MISSING
 * keys - so the repo .env can never override them. These tests use a
 * TEMPORARY fixture .env (never the repo one) and make no API calls.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { aiEnabled, loadEnv } from '../src/env.js';
import { buildChildEnv } from '../../../scripts/live-acceptance.mjs';

/** Isolated fixture dir with a deliberately CONTAMINATED .env. */
const fixtureDir = mkdtempSync(join(tmpdir(), 'indev-env-fixture-'));
writeFileSync(
  join(fixtureDir, '.env'),
  [
    '# fixture: what the repo .env must NEVER be able to do to an acceptance child',
    'STATIQ_API_TOKEN=fixture-token',
    'INDEV_MOCK=1',
    'AI_BASE_URL=https://ai.example/v1',
    'AI_API_KEY=fixture-ai-key',
    'AI_MODEL=fixture-model',
    '',
  ].join('\n'),
);

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('loadEnv precedence (fixture .env, no API calls)', () => {
  it('LIVE acceptance child: pinned mode/AI win over a contaminating .env', () => {
    // exactly what scripts/live-acceptance.mjs builds for a live run
    const childEnv = buildChildEnv('live', {
      STATIQ_API_TOKEN: 'parent-token', // parent channel (only creds pass through)
    });
    const env = loadEnv(fixtureDir, childEnv);
    // mode is pinned live: the fixture .env's INDEV_MOCK=1 cannot flip it
    expect(env.mock).toBe(false);
    // AI is off by construction: presence-pinned empty values cannot be
    // filled from the .env's AI_* config
    expect(aiEnabled(env)).toBe(false);
    // the credential channel still works (parent env wins over .env)
    expect(env.statiqToken).toBe('parent-token');
  });

  it('LIVE child with NO parent token: the .env token loads (selective credentials)', () => {
    const childEnv = buildChildEnv('live', {});
    const env = loadEnv(fixtureDir, childEnv);
    expect(env.mock).toBe(false);
    expect(aiEnabled(env)).toBe(false);
    expect(env.statiqToken).toBe('fixture-token');
  });

  it('even a fully contaminated parent (mock + AI) cannot make a live child', () => {
    const childEnv = buildChildEnv('live', {
      INDEV_MOCK: '1',
      AI_BASE_URL: 'https://ai.example/v1',
      AI_API_KEY: 'parent-ai-key',
      AI_MODEL: 'parent-model',
    });
    const env = loadEnv(fixtureDir, childEnv);
    expect(env.mock).toBe(false);
    expect(aiEnabled(env)).toBe(false);
  });

  it('MOCK acceptance child: tokenless and .env-free by construction', () => {
    const childEnv = buildChildEnv('mock', { STATIQ_API_TOKEN: 'should-be-stripped' });
    const env = loadEnv(fixtureDir, childEnv);
    expect(env.mock).toBe(true);
    // SKIP_DOTENV=1: the fixture .env is never read, so no token, no AI
    expect(env.statiqToken).toBeUndefined();
    expect(aiEnabled(env)).toBe(false);
  });

  it('CONTROL: normal dev launch (no explicit values) still fills from .env', () => {
    // this pins the fill-missing semantics the guarantees rely on: a plain
    // launch with an empty environment adopts the .env values (documented
    // dev mode selection via .env keeps working)
    const env = loadEnv(fixtureDir, {});
    expect(env.mock).toBe(true);
    expect(aiEnabled(env)).toBe(true);
    expect(env.statiqToken).toBe('fixture-token');
  });

  it('SKIP_DOTENV on the env itself also blocks the fixture .env', () => {
    const env = loadEnv(fixtureDir, { INDEV_SKIP_DOTENV: '1' });
    expect(env.statiqToken).toBeUndefined();
    expect(env.mock).toBe(false); // nothing filled: not mock
  });
});

describe('explicit bounded planning-budget overrides (defaults preserved)', () => {
  it('ABSENT overrides = defaults byte-identical: undefined fields', () => {
    const env = loadEnv(fixtureDir, {});
    expect(env.planMaxCalls).toBeUndefined();
    expect(env.planDeadlineMs).toBeUndefined();
    expect(env.planRetries).toBeUndefined();
  });

  it('PRESENT + valid = parsed explicit overrides (a coordinated acceptance shape)', () => {
    // the Delhi->Jaipur full-coverage shape: 421 calls min + slack, ~20 min
    // wall, zero retries for exact accounting - supplied EXPLICITLY
    const env = loadEnv(fixtureDir, {
      INDEV_PLAN_MAX_CALLS: '450',
      INDEV_PLAN_DEADLINE_MS: String(20 * 60_000),
      INDEV_PLAN_RETRIES: '0',
    });
    expect(env.planMaxCalls).toBe(450);
    expect(env.planDeadlineMs).toBe(20 * 60_000);
    expect(env.planRetries).toBe(0);
  });

  it('MALFORMED overrides fail LOUDLY at boot (no silent clamping)', () => {
    for (const [name, raw, min, max] of [
      ['INDEV_PLAN_MAX_CALLS', '0', 1, 10_000],
      ['INDEV_PLAN_MAX_CALLS', '-5', 1, 10_000],
      ['INDEV_PLAN_MAX_CALLS', '100001', 1, 10_000],
      ['INDEV_PLAN_MAX_CALLS', 'twelve', 1, 10_000],
      ['INDEV_PLAN_DEADLINE_MS', '1000', 10_000, 6 * 60 * 60_000],
      ['INDEV_PLAN_DEADLINE_MS', '99999999999', 10_000, 6 * 60 * 60_000],
      ['INDEV_PLAN_RETRIES', '4', 0, 3],
      ['INDEV_PLAN_RETRIES', '-1', 0, 3],
      ['INDEV_PLAN_RETRIES', 'two', 0, 3],
    ] as const) {
      expect(() => loadEnv(fixtureDir, { [name]: raw })).toThrow(
        new RegExp(`${name} must be an integer between ${min} and ${max}`),
      );
    }
  });

  it('the boundary values of each range are accepted', () => {
    const env = loadEnv(fixtureDir, {
      INDEV_PLAN_MAX_CALLS: '1',
      INDEV_PLAN_DEADLINE_MS: '10000',
      INDEV_PLAN_RETRIES: '3',
    });
    expect(env.planMaxCalls).toBe(1);
    expect(env.planDeadlineMs).toBe(10_000);
    expect(env.planRetries).toBe(3);
  });

  it('buildChildEnv passes the explicit overrides through (live + mock)', () => {
    // a future coordinated acceptance supplies them via the launch env;
    // the runner must not strip them from either mode's child
    for (const mode of ['live', 'mock'] as const) {
      const child = buildChildEnv(mode as string, {
        INDEV_PLAN_MAX_CALLS: '450',
        INDEV_PLAN_DEADLINE_MS: String(20 * 60_000),
        INDEV_PLAN_RETRIES: '0',
      });
      expect(child.INDEV_PLAN_MAX_CALLS).toBe('450');
      expect(child.INDEV_PLAN_DEADLINE_MS).toBe(String(20 * 60_000));
      expect(child.INDEV_PLAN_RETRIES).toBe('0');
    }
  });
});

describe('per-launch instance identity (INDEV_LAUNCH_ID)', () => {
  it('absent = undefined (plain dev launches need no identity)', () => {
    const env = loadEnv(fixtureDir, {});
    expect(env.launchId).toBeUndefined();
  });

  it('a launcher-supplied id parses as a plain passthrough (fixture .env too)', () => {
    const id = '0e7d9a12-9876-4c1b-b2a3-launch-test-uuid';
    expect(loadEnv(fixtureDir, { INDEV_LAUNCH_ID: id }).launchId).toBe(id);
    // dotenv fill-if-missing applies like every other key
    expect(loadEnv(fixtureDir, {}).launchId).toBeUndefined();
  });
});
