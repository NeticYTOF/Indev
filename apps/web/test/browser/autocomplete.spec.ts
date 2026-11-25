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
  const from = page.getByRole('combobox', { name: 'From', exact: true });
  const options = page.locator('[data-field=origin] .suggestions');
  await expect(from).toHaveAttribute('id', 'place-options-origin-input');
  await expect(from).toHaveAttribute('aria-controls', 'place-options-origin');
  await expect(from).toHaveAttribute('aria-autocomplete', 'list');
  await expect(from).toHaveAttribute('aria-expanded', 'false');
  await from.fill('Old query');
  await expect(options).toBeVisible();
  await expect(options).toHaveAttribute('id', 'place-options-origin');
  await expect(from).toHaveAttribute('aria-expanded', 'true');
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/geocode?q=New*', async (route) => {
    await held;
    await route.fulfill({ json: { hits: [{ label: 'Fresh town', name: 'Fresh', lat: 31, lon: 80 }] } });
  });
  await from.fill('New query');
  try {
    await expect(options).toBeHidden();
    await expect(from).toHaveAttribute('aria-expanded', 'false');
    await expect(from).not.toHaveAttribute('aria-activedescendant', /.+/);
    await expect(options.getByRole('option')).toHaveCount(0);
    await page.locator('#vehicle-select').focus();
    await from.focus();
    await expect(options).toBeHidden();
  } finally { release(); }
  await expect(options.getByRole('option')).toHaveText(['Fresh town']);
});

test('first ArrowUp selects the last place, then Enter picks it', async ({ page }) => {
  const from = page.getByRole('combobox', { name: 'From', exact: true });
  await from.fill('Town');
  await expect(page.locator('[data-field=origin]').getByRole('option')).toHaveCount(3);
  await from.press('ArrowDown');
  await expect(page.locator('[data-field=origin] .suggestion-item.active')).toHaveText('First town');
  await expect(page.locator('[data-field=origin] [role=option]').first()).toHaveAttribute('id', 'place-options-origin-option-0');
  await expect(from).toHaveAttribute('aria-activedescendant', 'place-options-origin-option-0');
  await expect(page.locator('[data-field=origin] [role=option]').first()).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-field=origin] [role=option][aria-selected=true]')).toHaveCount(1);
  await from.press('ArrowUp');
  await expect(page.locator('[data-field=origin] .suggestion-item.active')).toHaveText('Third town');
  await expect(from).toHaveAttribute('aria-activedescendant', 'place-options-origin-option-2');
  await expect(page.locator('[data-field=origin] [role=option]').first()).toHaveAttribute('aria-selected', 'false');
  await from.fill('Town again');
  await expect(page.locator('[data-field=origin]').getByRole('option')).toHaveCount(3);
  await from.press('ArrowUp');
  await expect(page.locator('[data-field=origin] .suggestion-item.active')).toHaveText('Third town');
  await page.screenshot({ path: test.info().outputPath('keyboard-last-option.png') });
  await from.press('Enter');
  await expect(from).toHaveValue('Third town');
  await expect(page.locator('[data-field=origin] .suggestions')).toBeHidden();
  await expect(from).toHaveAttribute('aria-expanded', 'false');
  await expect(from).not.toHaveAttribute('aria-activedescendant', /.+/);
  const to = page.getByRole('combobox', { name: 'To', exact: true });
  await expect(to).toHaveAttribute('id', 'place-options-destination-input');
  await expect(to).toHaveAttribute('aria-controls', 'place-options-destination');
  await to.fill('Destination');
  await expect(to).toHaveAttribute('aria-expanded', 'true');
  await page.locator('.suggestions:not(.hidden) [role=option]').first().click();
  const submitted = page.waitForRequest('**/api/plan');
  await page.route('**/api/plan', (route) => route.fulfill({
    status: 422, json: { code: 'not_determined', cause: 'budget-exhausted', error: 'Synthetic test boundary.' },
  }));
  await page.getByRole('button', { name: 'Plan route', exact: true }).click();
  expect((await submitted).postDataJSON().origin).toEqual({ label: 'Third town', lat: 30, lon: 79 });
});

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`no-results popup stays empty and non-selectable at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route('**/api/geocode?*', (route) => route.fulfill({ json: { hits: [] } }));
    const from = page.getByRole('combobox', { name: 'From', exact: true });
    const list = page.locator('[data-field=origin] .suggestions');
    await from.fill('Town');
    await expect(list.locator('.suggestion-item.is-empty')).toBeVisible();
    await expect(list.locator('.suggestion-item.is-empty')).toHaveCSS('color', 'rgb(182, 182, 176)');
    await expect(list).toHaveCSS('background-color', 'rgb(11, 11, 11)');
    await list.locator('.suggestion-item.is-empty').hover();
    await expect(list.locator('.suggestion-item.is-empty')).toHaveCSS('color', 'rgb(182, 182, 176)');
    await expect(list.locator('.suggestion-item.is-empty')).toHaveCSS('background-color', 'rgb(30, 30, 30)');
    await expect(list.getByRole('option')).toHaveCount(0);
    await expect(from).toHaveAttribute('aria-expanded', 'true');
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) {
      await from.press(key);
      await expect(list.locator('.suggestion-item.active')).toHaveCount(0);
      await expect(from).not.toHaveAttribute('aria-activedescendant', /.+/);
      await expect(from).toHaveValue('Town');
    }
    await page.screenshot({ path: test.info().outputPath(`no-results-${viewport.width}.png`) });
    await from.press('Escape');
    await expect(list).toBeHidden();
    await expect(from).toHaveAttribute('aria-expanded', 'false');
    await expect(from).not.toHaveAttribute('aria-activedescendant', /.+/);
    await expect(from).toBeFocused();
  });
}

test('suggestion active state clears on blur and Escape without losing refocus behavior', async ({ page }) => {
  const from = page.getByRole('combobox', { name: 'From', exact: true });
  const list = page.locator('[data-field=origin] .suggestions');
  await from.fill('Town');
  await expect(list.getByRole('option')).toHaveCount(3);
  await from.press('ArrowDown');
  await expect(from).toHaveAttribute('aria-activedescendant', 'place-options-origin-option-0');
  await page.locator('#vehicle-select').focus();
  await expect(list).toBeHidden();
  await expect(from).toHaveAttribute('aria-expanded', 'false');
  await expect(from).not.toHaveAttribute('aria-activedescendant', /.+/);
  await expect(list.locator('.suggestion-item.active')).toHaveCount(0);
  await expect(list.locator('[role=option][aria-selected=true]')).toHaveCount(0);
  await from.focus();
  await expect(list).toBeVisible();
  await expect(list.getByRole('option')).toHaveCount(3);
  await expect(from).toHaveAttribute('aria-expanded', 'true');
  await expect(from).not.toHaveAttribute('aria-activedescendant', /.+/);
  await expect(list.locator('.suggestion-item.active')).toHaveCount(0);
  await expect(list.locator('[role=option][aria-selected=true]')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('autocomplete-refocused.png') });
  await from.press('ArrowUp');
  await expect(from).toHaveAttribute('aria-activedescendant', 'place-options-origin-option-2');
  await from.press('Escape');
  await expect(list).toBeHidden();
  await expect(from).toHaveAttribute('aria-expanded', 'false');
  await expect(from).not.toHaveAttribute('aria-activedescendant', /.+/);
  await expect(list.getByRole('option')).toHaveCount(0);
  await page.locator('#vehicle-select').focus();
  await from.focus();
  await expect(list).toBeHidden();
  await expect(from).toHaveAttribute('aria-expanded', 'false');
  await expect(from).not.toHaveAttribute('aria-activedescendant', /.+/);
});

test('stale geocode HTTP error cannot clear newer active options', async ({ page }) => {
  let releaseOld!: () => void;
  const held = new Promise<void>((resolve) => { releaseOld = resolve; });
  await page.route('**/api/geocode?q=Old*', async (route) => {
    await held;
    await route.fulfill({ status: 500, json: { error: 'Synthetic stale geocode failure' } });
  });
  const from = page.getByRole('combobox', { name: 'From', exact: true });
  const list = page.locator('[data-field=origin] .suggestions');
  const started = page.waitForRequest('**/api/geocode?q=Old*');
  await from.fill('Old query');
  await started;
  try {
    await from.fill('New query');
    await expect(list.getByRole('option')).toHaveCount(3);
    await from.press('ArrowDown');
    await expect(from).toHaveAttribute('aria-activedescendant', 'place-options-origin-option-0');
    await expect(list.locator('[role=option][aria-selected=true]')).toHaveCount(1);
    const response = page.waitForResponse('**/api/geocode?q=Old*');
    releaseOld();
    const stale = await response;
    await stale.finished();
    await page.waitForTimeout(100);
    await expect(list).toBeVisible();
    await expect(from).toHaveAttribute('aria-expanded', 'true');
    await expect(list.getByRole('option')).toHaveCount(3);
    await expect(list.locator('[role=option]').first()).toHaveAttribute('aria-selected', 'true');
    await expect(list.locator('[role=option][aria-selected=true]')).toHaveCount(1);
    await expect(from).toHaveAttribute('aria-activedescendant', 'place-options-origin-option-0');
    await expect(from).toHaveValue('New query');
  } finally {
    releaseOld();
  }
});

test('current geocode HTTP 500 leaves combobox recoverable', async ({ page }) => {
  await page.route('**/api/geocode?q=Fail*', (route) => route.fulfill({
    status: 500, json: { error: 'Synthetic current geocode failure' },
  }));
  const from = page.getByRole('combobox', { name: 'From', exact: true });
  const list = page.locator('[data-field=origin] .suggestions');
  await from.fill('Town');
  await expect(list.getByRole('option')).toHaveCount(3);
  await from.press('ArrowDown');
  await expect(from).toHaveAttribute('aria-activedescendant', 'place-options-origin-option-0');
  await expect(list.locator('[role=option][aria-selected=true]')).toHaveCount(1);
  const response = page.waitForResponse('**/api/geocode?q=Fail*');
  await from.fill('Fail query');
  const failure = await response;
  await failure.finished();
  await page.waitForTimeout(100);
  expect(failure.status()).toBe(500);
  await expect(list).toBeHidden();
  await expect(from).toHaveAttribute('aria-expanded', 'false');
  await expect(from).not.toHaveAttribute('aria-activedescendant', /.+/);
  await expect(list.getByRole('option')).toHaveCount(0);
  await expect(list.locator('.suggestion-item.active')).toHaveCount(0);
  await expect(from).toHaveValue('Fail query');
  await from.fill('Recover');
  await expect(list.getByRole('option')).toHaveCount(3);
  await expect(from).toHaveAttribute('aria-expanded', 'true');
  await from.press('ArrowDown');
  await expect(from).toHaveAttribute('aria-activedescendant', 'place-options-origin-option-0');
  await expect(list.locator('[role=option][aria-selected=true]')).toHaveCount(1);
});
