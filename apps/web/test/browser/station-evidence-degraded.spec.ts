import { expect, test } from '@playwright/test';

test('successful zero-stop plan discloses incomplete station evidence without claiming failed samples', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(/^https?:\/\//, async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('**/api/plan', async route => {
    const response = await route.fetch(); const body = await response.json();
    body.plan.status = 'degraded'; body.plan.stops = [];
    body.plan.routeDistanceKm = 250; body.plan.routeDurationMin = 240;
    body.plan.totals = { distanceKm: 250, driveTimeMin: 240, chargeTimeMin: 0, totalTimeMin: 240, chargeKwh: 0, estPriceInr: null, finalSocPct: 30 };
    body.plan.warnings = ['Skipping fixture station: usable charger power is invalid; charging time cannot be verified.'];
    await route.fulfill({ response, json: body });
  });
  await page.goto('/');
  for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
    await page.getByRole('searchbox', { name, exact: true }).fill(query!);
    await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
  }
  await page.getByRole('button', { name: 'Plan route', exact: true }).click();
  const banner = page.locator('.plan-results .banner-warn').first();
  await expect(banner).toContainText('route samples or station evidence could not be verified');
  await expect(banner).not.toContainText('could not be scanned');
  await expect(page.locator('.no-stops')).toBeVisible();
  await expect(page.locator('[data-save]')).toBeEnabled();
  await banner.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('station-evidence-degraded.png') });
});
