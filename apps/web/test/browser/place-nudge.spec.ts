import { expect, test } from '@playwright/test';

// Typed-but-unpicked text gets an explicit "Use <top match>?" offer on blur.
// Nothing is ever picked implicitly: planning stays blocked until a tap.
test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('**/api/geocode?*', (route) => route.fulfill({ json: { hits: [
    { label: 'Jaipur, Rajasthan, India', name: 'Jaipur', lat: 26.91, lon: 75.79 },
    { label: 'Jaipur Road', name: 'Jaipur Road', lat: 20, lon: 86 },
  ] } }));
  await page.goto('/');
});

const field = (page: import('@playwright/test').Page) => page.locator('[data-field=destination]');
const nudge = (page: import('@playwright/test').Page) => field(page).locator('[data-place-nudge]');

test('blur offers the top match without picking it', async ({ page }) => {
  let plans = 0;
  await page.route('**/api/plan*', (route) => { plans++; return route.abort(); });
  const to = page.getByRole('combobox', { name: 'To', exact: true });
  await to.fill('Jaipur');
  await expect(field(page).locator('.suggestions').getByRole('option')).toHaveCount(2);
  await page.locator('#vehicle-select').focus();
  await expect(nudge(page)).toBeVisible();
  await expect(nudge(page).getByRole('button')).toHaveText('Use Jaipur, Rajasthan, India?');
  await expect(to).toHaveValue('Jaipur'); // text untouched, nothing picked
  await page.getByRole('button', { name: 'Plan route', exact: true }).click();
  await expect(page.locator('.error-box')).toContainText('Pick both a starting point');
  expect(plans).toBe(0);
});

test('tapping the offer picks it; editing again clears the offer', async ({ page }) => {
  const to = page.getByRole('combobox', { name: 'To', exact: true });
  await to.fill('Jaipur');
  await expect(field(page).locator('.suggestions').getByRole('option')).toHaveCount(2);
  await page.locator('#vehicle-select').focus();
  await nudge(page).getByRole('button').click();
  await expect(to).toHaveValue('Jaipur, Rajasthan, India');
  await expect(nudge(page)).toBeHidden();
  await page.locator('#vehicle-select').focus();
  await expect(nudge(page)).toBeHidden(); // picked: no offer on later blur
  await to.fill('Jai');
  await expect(nudge(page)).toBeHidden();
});

test('refocusing the field hides the offer and no offer appears without results', async ({ page }) => {
  const to = page.getByRole('combobox', { name: 'To', exact: true });
  await to.fill('Jaipur');
  await expect(field(page).locator('.suggestions').getByRole('option')).toHaveCount(2);
  await page.locator('#vehicle-select').focus();
  await expect(nudge(page)).toBeVisible();
  await to.focus();
  await expect(nudge(page)).toBeHidden();
  await page.route('**/api/geocode?*', (route) => route.fulfill({ json: { hits: [] } }));
  await to.fill('Zzzq');
  await expect(field(page).locator('.suggestions')).toContainText('No places found');
  await page.locator('#vehicle-select').focus();
  await expect(nudge(page)).toBeHidden();
});
