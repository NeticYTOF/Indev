import { expect, test } from '@playwright/test';

for (const failure of ['http', 'network']) {
test(`stop Revalidate recovers from ${failure} failure without duplicate requests`, async ({ page }) => {
  let lookups = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('https://tiles.openfreemap.org/styles/dark', (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background' }] },
  }));
  await page.route('**/api/stations/*', async (route) => { lookups++; if (lookups === 1) { await held; if (failure === 'network') await route.abort('failed'); else await route.fulfill({ status: 503, json: { error: 'Synthetic temporary error' } }); return; } await route.fulfill({ json: { station: {
    stationId: Number(new URL(route.request().url()).pathname.split('/').at(-1)),
    synthetic: true, rating: 4.3, reviewCount: 11, reliability: null,
    chargers: [{ lastUsedOn: '30/10/2026' }, { lastUsedOn: '02/11/2026' }],
    ccs2: { usable: 3, free: 2, faulted: 0, uncertain: 0 },
  } } }); });
  await page.goto('/');
  for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
    await page.getByRole('searchbox', { name, exact: true }).fill(query!);
    await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
  }
  await page.getByRole('button', { name: 'Plan route', exact: true }).click();
  await expect(page.locator('.pin-origin')).toHaveCount(1);
  const card = page.locator('.stop-card').first();
  await card.getByRole('button', { name: 'Revalidate', exact: true }).click();
  await expect.poll(() => lookups).toBe(1);
  const button = card.getByRole('button', { name: 'Revalidate', exact: true });
  await expect(button).toBeDisabled();
  await button.evaluate((element) => { for (let n = 0; n < 4; n++) element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  expect(lookups).toBe(1);
  release();
  await expect(card.locator('.revalidate-box')).toContainText('unavailable');
  await expect(button).toBeEnabled();
  await expect(button).toBeFocused();
  await button.click();
  await expect.poll(() => lookups).toBe(2);
  await expect(card.locator('.revalidate-box')).toHaveCount(1);
  await expect(button).toBeEnabled();
  await expect(button).toBeFocused();
  await expect(card.locator('.revalidate-box')).toContainText('Synthetic station');
  await expect(card.locator('.revalidate-box')).toContainText('3 usable CCS2 plugs');
  await expect(card.locator('.revalidate-box')).toContainText('2 free');
  const fetched = card.locator('[data-station-evidence-fetched] [data-station-evidence-result]');
  const lastUsedLabel = fetched.locator(':scope > .evidence-grid > div > dt', { hasText: /^Last used$/ });
  await expect(lastUsedLabel).toHaveCount(1);
  await expect(lastUsedLabel.locator('xpath=following-sibling::dd[1]')).toHaveText('2/11/2026');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('station-revalidated.png') });
});
}
