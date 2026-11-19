import { expect, test } from '@playwright/test';

test('rendered stop Revalidate requests fresh details and reports fixture provenance', async ({ page }) => {
  let lookups = 0;
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('https://tiles.openfreemap.org/styles/dark', (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background' }] },
  }));
  await page.route('**/api/stations/*', async (route) => { lookups++; await route.fulfill({ json: { station: {
    synthetic: true, rating: 4.3, reviewCount: 11, reliability: null,
    chargers: [{ lastUsedOn: '19/11/2026' }],
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
  await expect(card.locator('.revalidate-box')).toContainText('Synthetic station');
  await expect(card.locator('.revalidate-box')).toContainText('3 usable CCS2 plugs');
  await expect(card.locator('.revalidate-box')).toContainText('2 free');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('station-revalidated.png') });
});
