/**
 * Acceptance runner unit tests (pure helpers + one throwaway spawn).
 *
 * The reliability invariants these lock in:
 * - buildChildEnv is mode-exclusive: a MOCK acceptance child is tokenless
 *   by construction (token stripped + .env skipped) so a mock tooling
 *   check can NEVER go live unnoticed; a LIVE child never inherits parent
 *   mock/AI settings; neither mode carries AI planner config.
 * - exitCodeFor is fail-closed: 0 ONLY for plan-ok with matching
 *   provenance. The historical defect (process.exit(0) after a failed
 *   run) must never return.
 * - waitChildClose is STREAM-COMPLETE persistence: log capture survives a
 *   stdout drain that lands AFTER the child's exit event - the documented
 *   exit/stdio non-ordering that intermittently persisted an EMPTY
 *   server.log on a SUCCESS acceptance run (reproduced deterministically
 *   below via a controlled pause; NOT dismissed by the isolated rerun
 *   passing). The delayed-drain regression spawns a plain throwaway
 *   `node -e` child - never a server, never upstream.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildChildEnv, exitCodeFor, fetchWallMs, waitChildClose } from '../../../scripts/live-acceptance.mjs';

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
    // mode is PINNED live ('0') - loadEnv's .env fills only MISSING keys,
    // so neither the parent nor the repo .env can flip this run to mock
    expect(env.INDEV_MOCK).toBe('0');
    expect('INDEV_SKIP_DOTENV' in env).toBe(false); // live reads repo .env
    expect(env.STATIQ_API_TOKEN).toBe('live-secret-token'); // channel intact
    // AI is off by construction: presence-pinned EMPTY values
    expect(env.AI_BASE_URL).toBe('');
    expect(env.AI_API_KEY).toBe('');
    expect(env.AI_MODEL).toBe('');
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
    expect(env.INDEV_MOCK).toBe('0'); // pinned live, not merely absent
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

describe('fetchWallMs (inert unless an explicit override is supplied)', () => {
  it('default: exactly the previous wall (server budget + 30s slack)', () => {
    expect(fetchWallMs(undefined)).toBe(4 * 60_000 + 30_000);
    expect(fetchWallMs(Number.NaN)).toBe(4 * 60_000 + 30_000);
    expect(fetchWallMs(0)).toBe(4 * 60_000 + 30_000);
    expect(fetchWallMs(-1)).toBe(4 * 60_000 + 30_000);
  });

  it('an explicit per-launch deadline grows the wall (deadline + 30s slack)', () => {
    // a coordinated 20-minute acceptance must not be spuriously aborted at
    // the old 4.5-minute local wall
    expect(fetchWallMs(20 * 60_000)).toBe(20 * 60_000 + 30_000);
  });
});

/**
 * DELAYED-STDOUT-DRAIN REGRESSION (stream-complete persistence).
 *
 * Linux's full-suite run intermittently persisted an EMPTY server.log on a
 * SUCCESS acceptance run; the isolated rerun passed. Root cause verified
 * in source: the runner persisted at the child 'exit' event, but Node
 * documents NO ordering between 'exit' and stdio data delivery (the
 * SIGCHLD reap and the pipe drain are independent paths) - the rerun
 * passing is timing luck, not a dismissal of the failure.
 *
 * Deterministic construction: a throwaway child writes its lines and
 * exits while the test PAUSES the stream - so the data provably sits
 * undelivered AFTER the exit event (exactly the failing interleave).
 * The OLD persist-at-exit behavior is shown writing an EMPTY file; the
 * REPAIRED waitChildComplete path then drains fully and captures EVERY
 * line including the final one.
 */
describe('waitChildClose: stream-complete persistence (delayed drain)', () => {
  it('captures output delivered AFTER exit; persist-at-exit alone writes empty', async () => {
    const LINES = 40;
    const LAST = `DRILLED-FINAL-LINE-${LINES}-of-${LINES}`;
    const child = spawn(
      process.execPath,
      [
        '-e',
        `for (let i = 1; i < ${LINES}; i++) process.stdout.write('drill-line-' + i + '\\n'); process.stdout.write('${LAST}\\n');`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let received = '';
    child.stdout.on('data', (d) => {
      received += String(d);
    });
    // Controlled drain delay: nothing may flow until the test resumes.
    // This substitutes the OS-luck of the real race with a deterministic
    // disposition: the exit event fires while ALL data sits in the pipe.
    child.stdout.pause();

    await once(child, 'exit');
    // THE RACE, MADE DETERMINISTIC: 'exit' has fired and ZERO data has
    // been delivered - persisting at exit (the old behavior) writes empty
    expect(received).toBe('');
    const dir = mkdtempSync(join(tmpdir(), 'indev-drain-'));
    try {
      const exitOnlyPath = join(dir, 'exit-only.log');
      writeFileSync(exitOnlyPath, received);
      expect(readFileSync(exitOnlyPath, 'utf8')).toBe(''); // the bug, reproduced

      // THE REPAIR: waitChildClose resolves only on the child's 'close'
      // (exit AND full stdio drain). With the exit state set but the
      // stream NOT drained, it waits; resuming the stream fires the late
      // data events (after exit), then end+close - full capture follows.
      const closePromise = waitChildClose(child, 3_000);
      const beforeResume = received.length;
      child.stdout.resume(); // the late delivery happens NOW
      await closePromise;
      expect(received.length).toBeGreaterThan(beforeResume);
      // EVERY line captured, including the final one written pre-exit but
      // delivered post-exit
      expect(received).toContain(`drill-line-${LINES - 1}`);
      expect(received.trimEnd().endsWith(LAST)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true }); // fixture log, not run evidence
    }
  }, 10_000);
});
