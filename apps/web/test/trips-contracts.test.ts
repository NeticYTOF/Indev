import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Source-structure contracts for saved-trips-drawer keyboard resilience
 * (same pattern as a11y-contracts.test.ts: no DOM test env exists in
 * this workspace - vitest runs node and trips.ts imports maplibre - so
 * the wiring is locked as source-string regressions; rendered keyboard
 * behavior is verified by the independent Linux pass).
 */
const tripsSrc = readFileSync(new URL('../src/trips.ts', import.meta.url), 'utf8');
const mainSrc = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

describe('saved-trips drawer close: focus never dies with the drawer', () => {
  it('closes through one canonical helper', () => {
    // Old defect: the in-drawer Close button, the Open button and the
    // main.ts Escape handler each hid the drawer with a bare
    // classList.add('hidden') - the focused in-drawer control went
    // display:none and focus silently fell to <body>.
    expect(tripsSrc).toContain('export function hideTripsDrawer(');
    expect(tripsSrc).toContain('hideTripsDrawer(drawer);');
    expect((mainSrc.match(/hideTripsDrawer\(drawer\);/g) ?? []).length).toBe(2);
  });

  it('restores focus ONLY when the hide destroyed it (focus was inside)', () => {
    // A blanket focus-yank would steal focus from a planner field when
    // Escape closes an open drawer mid-typing - the guard is the contract.
    expect(tripsSrc).toContain('drawer.contains(document.activeElement)');
  });

  it('the restore target is the drawer owner, not a hidden element', () => {
    expect(tripsSrc).toContain("document.getElementById('trips-button')?.focus();");
  });
});

describe('opening a saved trip: focus lands on the rendered summary', () => {
  it('focuses the plan-results section after the sheet opens', () => {
    expect(tripsSrc).toContain("panel.querySelector<HTMLElement>('.plan-results')?.focus();");
  });

  it('makes the results section focusable even when REUSED from a live plan', () => {
    // renderPlanPanel creates .plan-results WITHOUT tabindex; the reuse
    // path must set it or the focus call silently fails.
    expect(tripsSrc).toContain("results.setAttribute('tabindex', '-1');");
  });
});

describe('saved-trip delete: single flight + focus that survives both outcomes', () => {
  it('refuses a second click while the DELETE is still in flight', () => {
    // Old defect: repeat clicks fired duplicate DELETEs; the second 404
    // toasted a false 'Could not delete' right after a successful delete.
    expect(tripsSrc).toContain('if (!btn || btn.disabled) return;');
    expect(tripsSrc).toContain('btn.disabled = true;');
  });

  it('re-enables the button on BOTH failure branches (res not ok, throw)', () => {
    expect((tripsSrc.match(/btn\.disabled = false;/g) ?? []).length).toBe(2);
    expect((tripsSrc.match(/document\.activeElement === document\.body/g) ?? []).length).toBe(2);
  });

  it('lands focus on the stable owner control before the refresh destroys the row', () => {
    // renderTripsDrawer clears innerHTML wholesale - the clicked button
    // dies with it; the owner control is the only stable target, and it
    // must receive focus BEFORE the refresh destroys the row.
    expect(tripsSrc)
      .toMatch(/document\.getElementById\('trips-button'\)\?\.focus\(\);\s+renderTripsDrawer\(drawer, map\); \/\/ refresh list/);
  });
});
