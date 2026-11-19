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
const stylesSrc = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const htmlSrc = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

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
  it('reveals the structured failure from its TOP so long errors are readable', () => {
    // 'nearest' left the title pinned at the bottom edge with the
    // details below the fold (rendered review); 'start' aligns the
    // failure top so it reads title-down.
    //
    // Scoped to the ERROR-BOX reveal ONLY (the \`box.\` subject): the
    // autocomplete's arrow-key navigation legitimately scrolls the
    // active suggestion with block:'nearest' (items[activeIndex]) and
    // must never be banned. Source contracts must not globally forbid
    // valid behavior elsewhere in the file.
    expect(plannerSrc).toContain("box.scrollIntoView({ block: 'start' })");
    expect(plannerSrc).not.toContain("box.scrollIntoView({ block: 'nearest' })");
  });

  it('returns focus to the submitting button after BOTH failed run paths', () => {
    // The disabled Plan/AI buttons lose focus to <body> during the wait;
    // both catch paths must land the user back on the retry control.
    expect(plannerSrc).toContain('focusOnSettle = planButton');
    expect(plannerSrc).toContain('focusOnSettle = aiButton');
    // WITHOUT scrolling: the rendering defect was the focus restore
    // scrolling the revealed error back below the viewport. The bare
    // (scrolling) focus call must be gone from both paths.
    const nonScrollingRestores = plannerSrc.match(
      /focusOnSettle\?\.focus\(\{ preventScroll: true \}\);/g,
    ) ?? [];
    expect(nonScrollingRestores).toHaveLength(2);
    expect(plannerSrc).not.toContain('focusOnSettle?.focus();');
  });
});

describe('planning run lifecycle (single flight by construction)', () => {
  it('gates both submit paths through the shared single-flight gate', () => {
    // Old defect: plan + AI runs could overlap; either finally hid the
    // shared busy readout while the other was STILL pending. Single flight
    // makes the overlap unreachable - both paths must begin through the
    // gate and release it in their finally.
    expect((plannerSrc.match(/gate\.tryBegin\(\)/g) ?? []).length).toBe(2);
    expect((plannerSrc.match(/gate\.end\(\)/g) ?? []).length).toBe(2);
  });

  it('reflects the shared busy state on BOTH submit controls', () => {
    expect((plannerSrc.match(/setActionsBusy\(true\)/g) ?? []).length).toBe(2);
    expect((plannerSrc.match(/setActionsBusy\(false\)/g) ?? []).length).toBe(2);
  });
});

describe('geocode race guard (makeSearchField ordering)', () => {
  it('gates every list application on the per-field session token', () => {
    expect(plannerSrc).toContain('const session = new GeocodeSession();');
    expect(plannerSrc).toContain('const token = session.begin();');
    // Stale responses apply nothing; the focus check also prevents the
    // blur orphan (a late response reopening the list with focus gone).
    expect(plannerSrc).toContain(
      'if (!session.isCurrent(token) || document.activeElement !== input) return;',
    );
  });

  it('a stale ERROR must not hide a newer query\u0027s list', () => {
    // Old defect: the catch path unconditionally hid the list.
    expect(plannerSrc).toContain('if (!session.isCurrent(token)) return;');
  });

  it('typing/clearing and picking invalidate in-flight responses', () => {
    // input listener (covers clearing: invalidate precedes the q<2 branch)
    // + the pick handler = exactly two call sites.
    expect((plannerSrc.match(/session\.invalidate\(\);/g) ?? []).length).toBe(2);
  });
});

describe('toast vs drawer overlays (mobile Close control)', () => {
  it('keeps #trips-drawer before #toast-root (sibling override contract)', () => {
    // The "drawer open" toast repositioning is a general-sibling CSS rule;
    // if the DOM order ever changes, the override silently dies.
    const drawerAt = htmlSrc.indexOf('id="trips-drawer"');
    const toastAt = htmlSrc.indexOf('id="toast-root"');
    expect(drawerAt).toBeGreaterThan(-1);
    expect(toastAt).toBeGreaterThan(drawerAt);
  });

  it('repositions toasts clear of the open drawer head on mobile', () => {
    // Old defect: with the drawer open on <=720px, toasts at
    // top: calc(58px + safe-t) sat directly over the drawer's sticky head
    // (top: calc(52px + safe-t), same right offset), covering the Close
    // control for the toast's duration.
    expect(stylesSrc).toContain('#trips-drawer:not(.hidden) ~ #toast-root');
    expect(stylesSrc).toContain('top: calc(52px + var(--safe-t) + 54px)');
  });
});
