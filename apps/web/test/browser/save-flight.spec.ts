import { expect, test } from '@playwright/test';

for (const failure of ['http', 'network']) {
test(`save ${failure} failure restores keyboard retry focus and blocks in-flight duplicates`, async ({ page }) => {
  let saves = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('**/api/trips', async (route) => {
    expect(route.request().method()).toBe('POST');
    saves++;
    if (saves === 1) {
      await held;
      if (failure === 'network') await route.abort('failed');
      else await route.fulfill({ status: 503, json: { error: 'Synthetic save unavailable' } });
    } else await route.fulfill({ json: { trip: { id: 'saved-fixture' } } });
  });
  await page.goto('/');
  for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
    await page.getByRole('combobox', { name, exact: true }).fill(query!);
    await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
  }
  await page.getByRole('button', { name: 'Plan route', exact: true }).click();
  const button = page.locator('[data-save]');
  await button.focus();
  await button.press('Enter');
  await expect.poll(() => saves).toBe(1);
  await expect(button).toBeDisabled();
  await button.evaluate((element) => {
    for (let n = 0; n < 4; n++) element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  // Let all duplicate event handlers dispatch before assessing the count.
  await page.waitForTimeout(100);
  expect(saves).toBe(1);
  release();
  await expect(button).toBeEnabled();
  await expect(button).toBeFocused();
  await button.press('Enter');
  await expect.poll(() => saves).toBe(2);
  await expect(button).toHaveText('Saved to your trips');
  await expect(button).toBeDisabled();
});
}
