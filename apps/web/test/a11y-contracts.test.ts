import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Source-structure contracts for keyboard/screenreader semantics that
 * this workspace cannot unit-test: vitest runs in a node env and
 * planner.ts imports maplibre (browser-only), so the a11y contracts
 * below are locked as source-string regressions against accidental
 * removal. The actual rendered/AT behavior is verified by the
 * independent Linux pixel + screen-reader pass.
 *
 * Each assertion documents the defect it locks out.
 */
const plannerSrc = readFileSync(new URL('../src/planner.ts', import.meta.url), 'utf8');

describe('planning wait-state announcements (no live-region spam)', () => {
  it('announces the stable hint exactly once: role=status lives on the hint line', () => {
    // The wait state must be announced when it appears - via a live region
    // on the STABLE content, so the announcement happens once.
    expect(plannerSrc).toContain('<p class="plan-busy-hint" role="status">');
  });

  it('keeps the ticking elapsed readout OUT of any live region', () => {
    // Old defect: the 5s-updated elapsed line itself carried role=status,
    // politely announcing "Ns elapsed" every 5 seconds for the whole wait.
    expect(plannerSrc).toContain('class="plan-busy-elapsed" aria-hidden="true"');
    expect(plannerSrc).not.toContain('class="plan-busy-time" role="status"');
  });
});

describe('planning failure reveal (keyboard reach + context restore)', () => {
  it('scrolls the structured failure details into view when rendered', () => {
    // Without this, a failure below the fold inside the scrollable panel
    // never reveals for sighted keyboard users.
    expect(plannerSrc).toContain("box.scrollIntoView({ block: 'nearest' })");
  });

  it('returns focus to the submitting button after BOTH failed run paths', () => {
    // The disabled Plan/AI buttons lose focus to <body> during the wait;
    // both catch paths must land the user back on the retry control.
    const focusRestores = plannerSrc.match(/focusOnSettle\?\.focus\(\)/g) ?? [];
    expect(focusRestores).toHaveLength(2);
    expect(plannerSrc).toContain('focusOnSettle = planButton');
    expect(plannerSrc).toContain('focusOnSettle = aiButton');
  });
});
