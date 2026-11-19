/**
 * Acceptance runner unit tests (pure helpers, no spawns, no upstream).
 *
 * The reliability invariants these lock in:
 * - buildChildEnv is mode-exclusive: a MOCK acceptance child is tokenless
 *   by construction (token stripped + .env skipped) so a mock tooling
 *   check can NEVER go live unnoticed; a LIVE child never inherits parent
 *   mock/AI settings; neither mode carries AI planner config.
 * - exitCodeFor is fail-closed: 0 ONLY for plan-ok with matching
 *   provenance. The historical defect (process.exit(0) after a failed
 *   run) must never return.
 */
import { describe, expect, it } from 'vitest';
import { buildChildEnv, exitCodeFor } from '../../../scripts/live-acceptance.mjs';

describe('buildChildEnv (mode-exclusive acceptance env)', () => {
  it('mock mode is tokenless by construction and skips the repo .env', () => {
    const env = buildChildEnv('mock', {
      STATIQ_API_TOKEN: 'live-secret-token',
      INDEV_SKIP_DOTENV: '0',
      AI_API_KEY: 'sk-x',
      AI_BASE_URL: 'https://ai.example',
      AI_MODEL: 'gpt-x',
    });
    expect(env.INDEV_MOCK).toBe('1');
    expect(env.INDEV_SKIP_DOTENV).toBe('1'); // the child cannot even load .env
    expect(env.STATIQ_API_TOKEN).toBeUndefined(); // tokenless: no live credential
    expect(env.AI_API_KEY).toBeUndefined();
    expect(env.AI_BASE_URL).toBeUndefined();
    expect(env.AI_MODEL).toBeUndefined();
  });

  it('live mode never inherits parent mock settings and keeps the .env channel', () => {
    const env = buildChildEnv('live', {
      INDEV_MOCK: '1', // contaminated parent (e.g. a mock shell)
      INDEV_SKIP_DOTENV: '1',
      STATIQ_API_TOKEN: 'live-secret-token',
      AI_MODEL: 'gpt-x',
    });
    // deleted, not merely overridden: the live server reads mode from absence
    expect('INDEV_MOCK' in env).toBe(false);
    expect('INDEV_SKIP_DOTENV' in env).toBe(false); // live reads repo .env
    expect(env.STATIQ_API_TOKEN).toBe('live-secret-token'); // channel intact
    expect(env.AI_MODEL).toBeUndefined();
    expect(env.AI_API_KEY).toBeUndefined();
    expect(env.AI_BASE_URL).toBeUndefined();
  });

  it('an empty parent env still yields a well-formed mock env', () => {
    const env = buildChildEnv('mock', {});
    expect(env.INDEV_MOCK).toBe('1');
    expect(env.INDEV_SKIP_DOTENV).toBe('1');
    expect(env.STATIQ_API_TOKEN).toBeUndefined();
  });

  it('the live server child is isolated from parent mock mode even without a token', () => {
    // no .env presence, no inherited token: the live server exits 1 itself
    // (its own fail-closed gate), which the runner reports as a failure
    const env = buildChildEnv('live', { INDEV_MOCK: '1' });
    expect('INDEV_MOCK' in env).toBe(false);
    expect(env.STATIQ_API_TOKEN).toBeUndefined();
  });
});

describe('exitCodeFor (fail-closed exit status)', () => {
  it('returns 0 ONLY for plan-ok with matching provenance', () => {
    expect(exitCodeFor({ outcome: 'plan-ok', sourceMatch: true })).toBe(0);
  });

  it('returns non-zero for source mismatches even when the HTTP call was ok', () => {
    expect(exitCodeFor({ outcome: 'plan-ok', sourceMatch: false })).not.toBe(0);
    expect(exitCodeFor({ outcome: 'source-mismatch', sourceMatch: false })).not.toBe(0);
    expect(exitCodeFor({ outcome: 'plan-ok' })).not.toBe(0); // match unproven
  });

  it('returns non-zero for every failure shape', () => {
    const failures = [
      { outcome: 'plan-http-error' },
      { outcome: 'mode-mismatch' },
      { outcome: 'source-mismatch' },
      { outcome: 'runner-error' },
      { outcome: 'server-unhealthy' },
      { outcome: 'unknown-new-failure' },
    ];
    for (const f of failures) {
      const code = exitCodeFor(f);
      expect(code).not.toBe(0);
      expect(Number.isInteger(code)).toBe(true);
    }
  });

  it('returns non-zero for a missing outcome', () => {
    expect(exitCodeFor(undefined)).not.toBe(0);
    expect(exitCodeFor(null)).not.toBe(0);
  });
});
