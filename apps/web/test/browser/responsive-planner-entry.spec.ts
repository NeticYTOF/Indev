import { expect, test } from '@playwright/test';

test('desktop-to-mobile resizing keeps an accessible planner entry', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.goto('/');
  await expect(page.getByRole('dialog', { name: 'Trip planner', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const fab = page.getByRole('button', { name: 'Open trip planner', exact: true });
  await expect(fab).toBeVisible();
  await expect(fab).toHaveAttribute('aria-expanded', 'false');
  await page.screenshot({ path: test.info().outputPath('mobile-entry.png') });
  await fab.click();
  await expect(page.getByRole('dialog', { name: 'Trip planner', exact: true })).toBeVisible();
  await expect(fab).toBeHidden();
  await page.getByRole('button', { name: 'Hide trip planner', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole('dialog', { name: 'Trip planner', exact: true })).toBeVisible();
  await expect(page.locator('#sheet-open')).toHaveAttribute('aria-expanded', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(fab).toBeVisible();
  await expect(fab).toHaveAttribute('aria-expanded', 'false');
});
