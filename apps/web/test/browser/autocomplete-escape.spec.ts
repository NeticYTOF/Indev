import { expect, test } from '@playwright/test';

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`Escape dismisses place choices before the planner at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route(/^https?:\/\//, async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
      else await route.abort();
    });
    await page.goto('/');
    const field = page.getByRole('searchbox', { name: 'From', exact: true });
    await field.fill('Delhi');
    const choices = page.locator('[data-field="origin"] .suggestions');
    await expect(choices).toBeVisible();
    await field.press('ArrowDown');
    await field.press('Escape');
    await expect(choices).toBeHidden();
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('Delhi');
    await page.screenshot({ path: test.info().outputPath('escaped-choices.png') });
    if (viewport.width <= 720) {
      await expect(page.locator('#planner-panel')).toHaveClass(/open/);
      await field.press('Escape');
      await expect(page.locator('#planner-panel')).not.toHaveClass(/open/);
      await expect(page.locator('#sheet-open')).toBeFocused();
    }
  });
}
