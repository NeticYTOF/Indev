import { expect, test } from '@playwright/test';

test('a failed health check does not claim the whole responding server is offline', async ({ page }) => {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('**/api/health', (route) => route.fulfill({ status: 503, json: { error: 'Synthetic health check unavailable' } }));
  await page.goto('/');
  await expect(page.locator('.server-offline')).toContainText('Server status unavailable');
  await expect(page.locator('#toast-root')).toContainText('Server status unavailable');
  await expect(page.locator('#health-badge')).toBeHidden();
  for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
    await page.getByRole('combobox', { name, exact: true }).fill(query!);
    await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
  }
  await page.locator('.planner-go').click();
  await expect(page.locator('.plan-results')).toContainText('Synthetic data');
  await expect(page.locator('.server-offline')).not.toContainText('Server offline');
  await page.screenshot({ path: test.info().outputPath('health-unavailable.png') });
});
