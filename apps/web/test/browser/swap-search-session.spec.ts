import { expect, test } from '@playwright/test';

test('route swap invalidates the old field query without changing swapped coordinates', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('**/api/geocode?*', async (route) => {
    const query = new URL(route.request().url()).searchParams.get('q');
    if (query === 'Old origin') {
      await held;
      await route.fulfill({ json: { hits: [{ label: 'Stale origin result', name: 'Old', lat: 10, lon: 20 }] } });
    } else await route.fulfill({ json: { hits: [{ label: 'Chosen destination', name: 'Chosen', lat: 27, lon: 76 }] } });
  });
  await page.goto('/');
  const from = page.getByRole('searchbox', { name: 'From', exact: true });
  const to = page.getByRole('searchbox', { name: 'To', exact: true });
  await to.fill('Destination');
  await page.locator('.suggestions:not(.hidden) [role=option]').first().click();
  const started = page.waitForRequest('**/api/geocode?q=Old%20origin');
  await from.fill('Old origin');
  await started;
  await page.getByRole('button', { name: 'Swap origin and destination', exact: true }).click();
  await expect(from).toHaveValue('Chosen destination');
  // User returns after the old field's blur timeout has settled.
  await page.waitForTimeout(220);
  await from.focus();
  const response = page.waitForResponse('**/api/geocode?q=Old%20origin');
  release();
  await response;
  // Let the response handler apply/discard its result.
  await page.waitForTimeout(100);
  await expect(page.locator('[data-field=origin] .suggestions')).toBeHidden();
  await expect(from).toHaveValue('Chosen destination');
  await to.fill('New destination');
  await page.locator('.suggestions:not(.hidden) [role=option]').first().click();
  const submitted = page.waitForRequest('**/api/plan');
  await page.route('**/api/plan', (route) => route.fulfill({ status: 422, json: { error: 'Synthetic boundary' } }));
  await page.getByRole('button', { name: 'Plan route', exact: true }).click();
  expect((await submitted).postDataJSON().origin).toEqual({ label: 'Chosen destination', lat: 27, lon: 76 });
});
