import { expect, test } from '@playwright/test';

test('quick refocus keeps place choices open after the old blur timeout', async ({ page }) => {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.goto('/');
  const field = page.getByRole('combobox', { name: 'From', exact: true });
  const choices = page.locator('[data-field=origin] .suggestions');
  await field.fill('Delhi');
  await expect(choices).toBeVisible();
  await page.locator('#vehicle-select').focus();
  await field.focus();
  // Cross the blur grace period, not a network timing assertion.
  await page.waitForTimeout(250);
  await expect(choices).toBeVisible();
  await expect(field).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('refocused-choices.png') });
  await page.locator('#vehicle-select').focus();
  await expect(choices).toBeHidden();
});
