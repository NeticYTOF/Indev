import { expect, test } from '@playwright/test';

test('opening a saved trip reopens mobile planner with matching expanded state', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('**/api/trips', (route) => route.fulfill({ json: { trips: [{
    id: 'local-fixture', name: 'Saved fixture', source: 'synthetic', createdAt: '2026-11-19T18:00:00Z',
    origin: { label: 'Delhi', lat: 28, lon: 77 }, destination: { label: 'Jaipur', lat: 27, lon: 76 },
    routeDistanceKm: 285, geometry: [[28, 77], [27, 76]], vehicle: { label: 'Fixture EV' },
    totals: { totalTimeMin: 200, chargeTimeMin: 20, finalSocPct: 25 }, stations: [],
  }] } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Hide trip planner', exact: true }).click();
  await expect(page.locator('#sheet-open')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#trips-button').click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('#planner-panel')).toHaveClass(/open/);
  await expect(page.locator('#sheet-open')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.plan-results')).toBeFocused();
  await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))));
  await page.screenshot({ path: test.info().outputPath('saved-mobile-expanded.png') });
});
