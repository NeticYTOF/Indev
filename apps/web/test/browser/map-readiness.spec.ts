import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function pickRoute(page: Page): Promise<void> {
  for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
    await page.getByRole('searchbox', { name, exact: true }).fill(query!);
    await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
  }
}

async function plan(page: Page): Promise<void> {
  const complete = page.waitForResponse('**/api/plan');
  await page.getByRole('button', { name: 'Plan route', exact: true }).click();
  expect((await complete).ok()).toBe(true);
  await expect(page.locator('.plan-results')).toBeVisible();
  await expect(page.locator('.plan-results')).toContainText('Synthetic');
  await expect(page.locator('.error-box')).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
test(`completed synthetic plan remains usable without map style at ${viewport.width}px`, async ({ page }) => {
  await page.setViewportSize(viewport);
  await page.goto('/');
  await pickRoute(page);
  await plan(page);
  await page.locator('.plan-results').scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('offline-map-plan.png') });
});
}

test('latest queued route draws once when the delayed local style becomes ready', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('https://tiles.openfreemap.org/styles/dark', async (route) => {
    await held;
    await route.fulfill({ json: { version: 8, sources: {}, layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#101827' } },
    ] } });
  });
  await page.goto('/');
  await pickRoute(page);
  await plan(page);
  await expect(page.locator('.pin-origin')).toHaveCount(0);
  await page.getByRole('button', { name: 'Swap origin and destination', exact: true }).click();
  await plan(page);
  release();
  await expect(page.locator('.pin-origin')).toHaveCount(1);
  await expect(page.locator('.pin-origin')).toHaveAttribute('aria-label', /Jaipur/);
  await expect(page.locator('.pin-destination')).toHaveAttribute('aria-label', /Delhi/);
  await expect(page.locator('.error-box')).toBeHidden();
  // Let the route framing animation finish before pixel evidence.
  await page.waitForTimeout(900);
  await page.screenshot({ path: test.info().outputPath('delayed-style-latest-route.png') });
});
