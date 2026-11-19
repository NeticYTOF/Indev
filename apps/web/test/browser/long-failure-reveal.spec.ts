/**
 * Browser regression: long-failure reveal on mobile 390x844 + desktop.
 *
 * Defect (independent rendered review of the e5e1a91-era focus restore,
 * mobile 390x844): after the failure revealed the error box, the final
 * focus restore scrolled it back BELOW the viewport - title pinned near
 * the bottom edge (~805 of 844), details hidden. The repair keeps BOTH
 * goals: retry button focused AND the revealed error readable, because
 * the focus restore uses preventScroll and the reveal aligns the
 * failure top (block:'start').
 *
 * Determinism: /api/plan is INTERCEPTED with a synthetic 422
 * not_determined body (cause budget-exhausted, long coverage evidence).
 * Evidence is synthetic intercepted only; nothing here claims a verdict
 * about live data, and no provider traffic happens - geocode + the page
 * itself come from the mock dev stack (npm run dev:stack, INDEV_MOCK=1).
 *
 * Run (Linux): npx playwright test --project=chromium
 */
import { expect, test, type Page } from '@playwright/test';

const LONG_EVIDENCE =
  'Plan not determined: the run exhausted its budget of 200 upstream attempts before the whole route could be scanned. ' +
  'route samples covered 12 of 60 planned (3 failed); candidates processed 40/396 (12 detailed, 356 remaining); ' +
  'rough estimate: ~356 more upstream calls remain for full fresh coverage (~14.7 min at ~2.48s/call sustained safety ' +
  'pacing - advisory, a sustained-pacing estimate, not a strict bound; zero-retry assumption - latency, backoff and ' +
  'retries only add; the candidate pool is not yet discovered). ' +
  'Coverage is incomplete - this is NOT a verdict that the route is impossible, and no trip was saved. ' +
  'Retry, or raise the run budget for long routes.';

interface RevealState {
  title: boolean;
  detail: boolean;
  focused: boolean;
}

async function revealState(page: Page): Promise<RevealState> {
  return page.evaluate(() => {
    const title = document.querySelector('.error-box .error-title') as HTMLElement | null;
    const detail = document.querySelector('.error-box .error-detail') as HTMLElement | null;
    const go = document.querySelector('.planner-go');
    if (!title || !detail) return { title: false, detail: false, focused: false };
    const r1 = title.getBoundingClientRect();
    const r2 = detail.getBoundingClientRect();
    return {
      title: r1.top >= 0 && r1.bottom <= window.innerHeight,
      detail: r2.top >= 0 && r2.bottom <= window.innerHeight,
      focused: document.activeElement === go,
    };
  });
}

test.beforeEach(async ({ page }) => {
  // Synthetic determinism: only the plan call is intercepted.
  await page.route('**/api/plan', (route) =>
    route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        error: LONG_EVIDENCE,
        code: 'not_determined',
        cause: 'budget-exhausted',
      }),
    }),
  );
});

async function forceLongFailure(page: Page): Promise<void> {
  const from = page.getByPlaceholder('From');
  await from.fill('Delhi');
  await page.locator('.suggestion-item').first().click();
  const to = page.getByPlaceholder('To');
  await to.fill('Jaipur');
  await page.locator('.suggestion-item').first().click();
  await page.getByRole('button', { name: 'Plan route' }).click();
  await expect(page.locator('.error-box .error-title')).toContainText('Run budget exhausted');
  await expect(page.locator('.error-box .error-raw')).toContainText('rough estimate');
}

test('mobile 390x844: long failure readable AND retry button keeps focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await forceLongFailure(page);

  const state = await revealState(page);
  // Both goals hold SIMULTANEOUSLY: revealed title + guidance detail inside
  // the viewport, and the retry control focused.
  expect(state.title).toBeTruthy();
  expect(state.detail).toBeTruthy();
  expect(state.focused).toBeTruthy();

  // And it STAYS: no post-settle focus scroll pushes the error back
  // below the fold (the original defect's exact failure mode).
  await page.waitForTimeout(500);
  const after = await revealState(page);
  expect(after.title).toBeTruthy();
  expect(after.detail).toBeTruthy();
  expect(after.focused).toBeTruthy();
});

test('desktop 1280x800: same invariants', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await forceLongFailure(page);

  const state = await revealState(page);
  expect(state.title).toBeTruthy();
  expect(state.detail).toBeTruthy();
  expect(state.focused).toBeTruthy();
});
