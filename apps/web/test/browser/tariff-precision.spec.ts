import { expect, test } from '@playwright/test';

test('stop tariff preserves paise precision and unknown is not zero', async ({ page }) => {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('**/api/plan', async (route) => {
    const response = await route.fetch(); const body = await response.json();
    body.plan.stops[0].pricePerKwh = 22.75;
    body.plan.stops[1].pricePerKwh = null;
    await route.fulfill({ json: body });
  });
  await page.goto('/');
  for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
    await page.getByRole('combobox', { name, exact: true }).fill(query!);
    await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
  }
  await page.locator('.planner-go').click();
  await expect(page.locator('.stop-tariff')).toHaveText(['Rs. 22.75/kWh', 'Tariff unknown']);
  await page.locator('.stop-card').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('tariff-precision.png') });
});
