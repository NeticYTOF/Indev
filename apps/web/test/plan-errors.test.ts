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
] as const;

describe('plan failure guidance (cause-true, never a fake diagnosis)', () => {
  it('maps every server cause to guidance naming that cause', () => {
    for (const cause of KNOWN_CAUSES) {
      const g = planFailureGuidance(cause);
      expect(g.title.length).toBeGreaterThan(0);
      expect(g.detail.length).toBeGreaterThan(20);
      expect(g.toast.length).toBeGreaterThan(0);
    }
  });

  it('only the throttle causes tell the user to wait and retry', () => {
    for (const cause of KNOWN_CAUSES) {
      const g = planFailureGuidance(cause);
      const advisesWaiting = /wait/i.test(g.detail);
      expect(advisesWaiting).toBe(isThrottleCause(cause));
    }
  });

  it('budget-exhausted never claims throttling or encourages an instant retry', () => {
    const g = planFailureGuidance('budget-exhausted');
    expect(g.title).toContain('not throttling');
    // The old lie - "the charger API is throttling. Retry in a minute" -
    // must not survive for the most common long-corridor failure.
    expect(g.detail).toMatch(/same cap/);
    expect(g.toast).toContain('not throttling');
  });

  it('auth guidance says retrying will not help (a server config problem)', () => {
    const g = planFailureGuidance('auth');
    expect(g.detail).toMatch(/Retrying will not help/);
    expect(g.detail).toMatch(/token/i);
  });

  it('coverage causes never claim the route is impossible', () => {
    for (const cause of ['scan-coverage', 'candidate-holes', 'deadline'] as const) {
      const g = planFailureGuidance(cause);
      expect(g.detail).toContain('not a verdict');
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
