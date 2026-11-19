import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('**/api/geocode?*', (route) => route.fulfill({ json: { hits: [
    { label: 'First town', name: 'First', lat: 28, lon: 77 },
    { label: 'Second town', name: 'Second', lat: 29, lon: 78 },
    { label: 'Third town', name: 'Third', lat: 30, lon: 79 },
  ] } }));
  await page.goto('/');
});

test('editing a query clears obsolete choices before the next response', async ({ page }) => {
  const from = page.getByRole('searchbox', { name: 'From', exact: true });
  const options = page.locator('[data-field=origin] .suggestions');
  await from.fill('Old query');
  await expect(options).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/geocode?q=New*', async (route) => {
    await held;
    await route.fulfill({ json: { hits: [{ label: 'Fresh town', name: 'Fresh', lat: 31, lon: 80 }] } });
  });
  await from.fill('New query');
  try {
    await expect(options).toBeHidden();
    await expect(options.getByRole('option')).toHaveCount(0);
    await page.locator('#vehicle-select').focus();
    await from.focus();
    await expect(options).toBeHidden();
  } finally { release(); }
  await expect(options.getByRole('option')).toHaveText(['Fresh town']);
});

test('first ArrowUp selects the last place, then Enter picks it', async ({ page }) => {
  const from = page.getByRole('searchbox', { name: 'From', exact: true });
  await from.fill('Town');
  await expect(page.locator('[data-field=origin]').getByRole('option')).toHaveCount(3);
  await from.press('ArrowDown');
  await expect(page.locator('[data-field=origin] .suggestion-item.active')).toHaveText('First town');
  await from.press('ArrowUp');
  await expect(page.locator('[data-field=origin] .suggestion-item.active')).toHaveText('Third town');
  await from.fill('Town again');
  await expect(page.locator('[data-field=origin]').getByRole('option')).toHaveCount(3);
  await from.press('ArrowUp');
  await expect(page.locator('[data-field=origin] .suggestion-item.active')).toHaveText('Third town');
  await page.screenshot({ path: test.info().outputPath('keyboard-last-option.png') });
  await from.press('Enter');
  await expect(from).toHaveValue('Third town');
  await expect(page.locator('[data-field=origin] .suggestions')).toBeHidden();
  const to = page.getByRole('searchbox', { name: 'To', exact: true });
  await to.fill('Destination');
  await page.locator('.suggestions:not(.hidden) [role=option]').first().click();
  const submitted = page.waitForRequest('**/api/plan');
  await page.route('**/api/plan', (route) => route.fulfill({
    status: 422, json: { code: 'not_determined', cause: 'budget-exhausted', error: 'Synthetic test boundary.' },
  }));
  await page.getByRole('button', { name: 'Plan route', exact: true }).click();
  expect((await submitted).postDataJSON().origin).toEqual({ label: 'Third town', lat: 30, lon: 79 });
});
