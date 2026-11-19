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
 *   server.log on a SUCCESS acceptance run (NOT dismissed by the isolated
 *   rerun passing). The ordering is CONSTRUCTED with a controlled
 *   event/stream fake (a paused REAL child stdout does NOT stay empty at
 *   exit - Node auto-resumes/flushes it, empirically confirmed by the
 *   226/227 suite run), plus a real-child EVENTUAL complete-output
 *   assertion with no ordering assumption. Fixes spawn only a plain
 *   throwaway `node -e` child / fake - never a server, never upstream.
 */
import { spawn } from 'node:child_process';
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
 * FIXTURE CORRECTION (Linux 226/227): the first version of this regression
 * wrongly ASSUMED a paused real-child stdout stays empty after exit - Node
 * auto-resumes/flushes piped stdout at exit (all 40 lines were already
 * present). The assumption failed, NOT the production close-wait: the
 * c463884 waitChildClose behavior is not disproven by that fixture failure.
 * The ordering is therefore CONSTRUCTED with a controlled event/stream fake
 * (exit state already set, streams NOT drained, data/end/close explicitly
 * delayed until the test delivers them), plus a real-child EVENTUAL
 * complete-output assertion with no ordering assumption. The original
 * observed output-loss evidence is preserved and reproduced by the fake.
 */
describe('waitChildClose: stream-complete persistence (delayed drain)', () => {
  /**
   * Controlled fake of an EXITED child whose streams have NOT yet drained:
   * exact post-exit state waitChildClose reads (exitCode set, signalCode
   * null, readableEnded/destroyed false). The test alone can settle the
   * wait - by delivering the late output and firing close - so the
   * construction cannot depend on Node's stream scheduling at all.
   */
  function makeFakeExitedChild() {
    const closeWaiters: Array<() => void> = [];
    const child = {
      exitCode: 0,
      signalCode: null,
      stdout: { readableEnded: false, destroyed: false },
      stderr: { readableEnded: false, destroyed: false },
      once(event: string, fn: () => void) {
        if (event === 'close') closeWaiters.push(fn);
        return child;
      },
      /** The LATE delivery: data landed, end observed (readableEnded),
       *  then the child 'close' event fires - in that order. */
      deliverLateOutputAndClose() {
        child.stdout.readableEnded = true;
        child.stderr.readableEnded = true;
        for (const w of closeWaiters.splice(0)) w();
      },
    };
    return child;
  }

  it('captures data delivered AFTER exit; the old persist-at-exit wrote empty', async () => {
    const child = makeFakeExitedChild();
    const LINES = 40;
    const LAST = `LATE-FINAL-LINE-${LINES}-of-${LINES}`;
    // the accumulator the runner's persistence writes
    let received = '';
    const dir = mkdtempSync(join(tmpdir(), 'indev-drain-'));
    try {
      // THE OBSERVED INCIDENT, reproduced deterministically: at exit the
      // captured output is still empty (everything is in flight) - the
      // old persist-at-exit wrote exactly this empty file
      const exitOnlyPath = join(dir, 'exit-only.log');
      writeFileSync(exitOnlyPath, received);
      expect(readFileSync(exitOnlyPath, 'utf8')).toBe('');

      // REPAIR: with the exit state set but streams NOT drained,
      // waitChildClose must WAIT - only the stream-complete close may
      // settle it, never the bare exit state
      let settled = false;
      const pending = waitChildClose(child, 3_000).then(() => {
        settled = true;
      });
      // a few turns of the loop: the fake can settle ONLY via the explicit
      // close below or the 3s timer - neither has happened by 25ms
      await new Promise((r) => setTimeout(r, 25));
      expect(settled).toBe(false);

      // the LATE delivery happens NOW: data events after exit, then end,
      // then close
      received +=
        Array.from({ length: LINES - 1 }, (_, i) => `late-line-${i + 1}\n`).join('') +
        `${LAST}\n`;
      child.deliverLateOutputAndClose();
      await pending;
      expect(settled).toBe(true);

      // persistence AFTER the close-wait captures EVERYTHING, including
      // the final line that was still in flight at exit
      expect(received).toContain('late-line-1');
      expect(received).toContain(`late-line-${LINES - 1}`);
      expect(received.trimEnd().endsWith(LAST)).toBe(true);
      const capturedPath = join(dir, 'captured.log');
      writeFileSync(capturedPath, received);
      expect(readFileSync(capturedPath, 'utf8')).toBe(received);
    } finally {
      rmSync(dir, { recursive: true, force: true }); // fixture log, not run evidence
    }
  }, 5_000);

  it('an already-drained exited child settles via the fast path (no timer wait)', async () => {
    // the fast path (exit state set AND all streams drained) settles
    // immediately - guarding teardowns against degenerating into
    // timer-only waits (every success run would pay the full bound)
    const child = makeFakeExitedChild();
    child.stdout.readableEnded = true;
    child.stderr.readableEnded = true; // fully wound down: close already fired
    let settled = false;
    void waitChildClose(child, 5_000).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 25));
    expect(settled).toBe(true);
  }, 2_000);

  it('real throwaway child: the FULL output is present once the close-wait settles', async () => {
    // NO ordering assumption: whether Node delivers before or after the
    // exit event is irrelevant (and empirically variable - Node
    // auto-flushes piped stdout at exit). The CONTRACT under test is
    // that once waitChildClose settles on close, everything is captured.
    const LINES = 40;
    const LAST = `DRILL-FINAL-LINE-${LINES}-of-${LINES}`;
    const child = spawn(
      process.execPath,
      [
        '-e',
        `for (let i = 1; i < ${LINES}; i++) process.stdout.write('drill-line-' + i + '\\n'); process.stdout.write('${LAST}\\n');`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let received = '';
    let stderrReceived = '';
    child.stdout.on('data', (d) => {
      received += String(d);
    });
    // mirror the production runner: BOTH streams carry handlers and flow
    child.stderr.on('data', (d) => {
      stderrReceived += String(d);
    });
    await waitChildClose(child, 5_000);
    expect(received).toContain(`drill-line-${LINES - 1}`);
    expect(received.trimEnd().endsWith(LAST)).toBe(true);
    expect(typeof stderrReceived).toBe('string');
  }, 10_000);
});
