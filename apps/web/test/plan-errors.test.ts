import { describe, expect, it } from 'vitest';
import {
  formatElapsedMs,
  isThrottleCause,
  planFailureGuidance,
} from '../src/plan-errors.js';

const KNOWN_CAUSES = [
  'throttled',
  'sample-throttled',
  'auth',
  'budget-exhausted',
  'deadline',
  'scan-coverage',
  'candidate-holes',
  'ai-provider',
] as const;

// Inherited Object.prototype keys that a buggy or hostile server could
// send as a cause string; a plain `in`/index lookup would resolve these
// to FUNCTIONS, not guidance. They must fall to the default.
const PROTOTYPE_KEYS = [
  'toString',
  'constructor',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__proto__',
] as const;

describe('plan failure guidance lookup (own-key only, null prototype)', () => {
  it('maps every server cause to guidance naming that cause', () => {
    for (const cause of KNOWN_CAUSES) {
      const g = planFailureGuidance(cause);
      expect(g.title.length).toBeGreaterThan(0);
      expect(g.detail.length).toBeGreaterThan(20);
      expect(g.toast.length).toBeGreaterThan(0);
    }
  });

  it('prototype-inherited keys can never masquerade as causes', () => {
    for (const key of PROTOTYPE_KEYS) {
      const g = planFailureGuidance(key);
      // Never a function/object cast: always the honest default.
      expect(g.title).toBe('Plan not determined');
      expect(typeof g.detail).toBe('string');
      expect(typeof g.toast).toBe('string');
    }
  });

  it('unknown or absent causes fall back to the honest no-verdict default', () => {
    for (const cause of [undefined, '', 'something-new']) {
      const g = planFailureGuidance(cause);
      expect(g.title).toBe('Plan not determined');
      expect(g.detail).toContain('not a verdict');
    }
  });
});

describe('plan failure guidance correctness (cause-true, never invented)', () => {
  it('only the throttle causes tell the user to wait and retry', () => {
    for (const cause of KNOWN_CAUSES) {
      const g = planFailureGuidance(cause);
      const advisesWaiting = /wait/i.test(g.detail);
      expect(advisesWaiting).toBe(isThrottleCause(cause));
    }
  });

  it('throttle guidance mentions the requested wait ONLY if one was supplied', () => {
    for (const cause of ['throttled', 'sample-throttled'] as const) {
      const g = planFailureGuidance(cause);
      // The old blanket lie was "Retry in a minute"; the follow-up defect
      // was ASSUMING the API always supplies Retry-After. The conditional
      // form ("if it specified") is the contract: never a blanket number,
      // never an asserted wait that may not exist.
      expect(g.detail).not.toMatch(/minute/i);
      expect(g.detail).toMatch(/pause the API asked for/);
      expect(g.detail).toMatch(/if it specified an exact wait, that number is in the details below/);
      expect(g.detail).not.toMatch(/the requested wait is in the details/);
      expect(g.toast).not.toMatch(/minute/i);
      expect(g.toast).toMatch(/pause to lift/);
    }
  });

  it('budget-exhausted does not diagnose pool-over-cap or promise retry success', () => {
    const g = planFailureGuidance('budget-exhausted');
    expect(g.title).toContain('not throttling');
    // Retries count against the same cap; the mechanism is not asserted.
    expect(g.detail).toMatch(/every retry counts/i);
    expect(g.detail).not.toMatch(/needs more checks than/i);
    // No shorter-route / fresh-retry success promise.
    expect(g.detail).not.toMatch(/shorter route/i);
    expect(g.detail).not.toMatch(/\bis guaranteed\b/i);
    expect(g.detail).not.toMatch(/\bwill succeed\b/i);
    expect(g.detail).toMatch(/not guaranteed to succeed/);
    expect(g.detail).toMatch(/details below/); // attempts/candidates evidence is pointed at, never hidden
    expect(g.toast).toContain('not throttling');
  });

  it('deadline guidance names the run, never a phase without evidence', () => {
    const g = planFailureGuidance('deadline');
    expect(g.detail).toMatch(/\brun\b/i);
    expect(g.detail).not.toMatch(/corridor scan/i);
    // Phase evidence lives in the server's timings, deferred to details.
    expect(g.detail).toMatch(/phase timings.*details below/);
  });

  it('auth guidance names credentials OR access - no categorical retry verdict', () => {
    const g = planFailureGuidance('auth');
    expect(g.detail).toMatch(/401\/403/);
    expect(g.detail).toMatch(/invalid or expired/i);
    expect(g.detail).toMatch(/lack access/i);
    expect(g.detail).not.toMatch(/replac/i);
    // Never categorical: a retry IS useful if the token/access side
    // actually changed - not "retry never changes it".
    expect(g.detail).toMatch(/only useful after something on that side actually changes/);
    expect(g.detail).not.toMatch(/\bnever\b/i);
    expect(g.detail).not.toMatch(/will not change/);
  });

  it('coverage causes never claim the route is impossible', () => {
    for (const cause of ['scan-coverage', 'candidate-holes', 'deadline'] as const) {
      const g = planFailureGuidance(cause);
      expect(g.detail).toContain('not a verdict');
    }
  });
});

describe('formatElapsedMs (honest loading timer)', () => {
  it('formats seconds, minutes and hours without padding noise', () => {
    expect(formatElapsedMs(0)).toBe('0s');
    expect(formatElapsedMs(4_999)).toBe('4s');
    expect(formatElapsedMs(59_999)).toBe('59s');
    expect(formatElapsedMs(60_000)).toBe('1m');
    expect(formatElapsedMs(65_000)).toBe('1m 5s');
    expect(formatElapsedMs(3_599_000)).toBe('59m 59s');
    expect(formatElapsedMs(3_600_000)).toBe('1h');
    expect(formatElapsedMs(3_723_000)).toBe('1h 2m');
  });

  it('never goes negative', () => {
    expect(formatElapsedMs(-5_000)).toBe('0s');
  });
});
