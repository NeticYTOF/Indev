import { expect, test } from '@playwright/test';

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`successful keyboard plan reveals route summary at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route(/^https?:\/\//, async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
      else await route.abort();
    });
    await page.goto('/');
    for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
      await page.getByRole('combobox', { name, exact: true }).fill(query!);
      await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
    }
    await page.getByRole('button', { name: 'Plan route', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.plan-results')).toBeVisible();
    await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))));
    await page.screenshot({ path: test.info().outputPath('plan-success.png') });
    const state = await page.locator('.plan-results .plan-route').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const panel = document.getElementById('planner-panel')!.getBoundingClientRect();
      return { readable: rect.top >= Math.max(0, panel.top) && rect.bottom <= Math.min(innerHeight, panel.bottom),
        focused: document.activeElement === element.closest('.plan-results'), top: rect.top, bottom: rect.bottom };
    });
    expect(state.readable).toBe(true);
    expect(state.focused).toBe(true);
    await expect(page.locator('.plan-results .trip-strip')).toBeInViewport();
  });
}

test('success does not steal focus deliberately moved during a pending plan', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('**/api/plan', async (route) => {
    const response = await route.fetch(); await held; await route.fulfill({ response });
  });
  await page.goto('/');
  for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
    await page.getByRole('combobox', { name, exact: true }).fill(query!);
    await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
  }
  await page.getByRole('button', { name: 'Plan route', exact: true }).click();
  const field = page.getByRole('combobox', { name: 'From', exact: true });
  await field.focus();
  release();
  await expect(page.locator('.plan-results')).toBeVisible();
  await expect(field).toBeFocused();
});
