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
