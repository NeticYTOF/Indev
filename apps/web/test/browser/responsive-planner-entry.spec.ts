import { expect, test } from '@playwright/test';

test('desktop-to-mobile resizing keeps an accessible planner entry', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.goto('/');
  await expect(page.getByRole('dialog', { name: 'Trip planner', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const fab = page.getByRole('button', { name: 'Open trip planner', exact: true });
  await expect(fab).toBeVisible();
  await expect(fab).toHaveAttribute('aria-expanded', 'false');
  await page.screenshot({ path: test.info().outputPath('mobile-entry.png') });
  await fab.click();
  await expect(page.getByRole('dialog', { name: 'Trip planner', exact: true })).toBeVisible();
  await expect(fab).toBeHidden();
  await page.getByRole('button', { name: 'Hide trip planner', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole('dialog', { name: 'Trip planner', exact: true })).toBeVisible();
  await expect(page.locator('#sheet-open')).toHaveAttribute('aria-expanded', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(fab).toBeVisible();
  await expect(fab).toHaveAttribute('aria-expanded', 'false');
});

async function wireDrawer(page: import('@playwright/test').Page): Promise<() => number> {
  let plans = 0;
  await page.route(/^https?:\/\//, async route => { const url = new URL(route.request().url()); await (url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? route.continue() : route.abort()); });
  await page.route('**/api/trips', route => route.fulfill({ json: { trips: [] } }));
  await page.route('**/api/plan', async route => { plans += 1; await route.abort(); });
  await page.route('**/api/geocode*', route => route.fulfill({ json: { hits: [{ name: 'Delhi', label: 'Delhi', lat: 28, lon: 77 }, { name: 'Jaipur', label: 'Jaipur', lat: 26.9, lon: 75.8 }] } }));
  return () => plans;
}

for (const [label, width, startsOpen] of [['mobile', 390, true], ['desktop resize', 1280, false]] as const) {
  test(`saved drawer excludes background planner: ${label}`, async ({ page }) => {
    const planRequests = await wireDrawer(page);
    await page.setViewportSize({ width, height: 844 }); await page.goto('/');
    const planner = page.getByRole('dialog', { name: 'Trip planner', exact: true }), fab = page.getByRole('button', { name: 'Open trip planner', exact: true });
    await expect(planner).toBeVisible();
    for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']] as const) {
      await page.getByRole('combobox', { name, exact: true }).fill(query); await page.locator('.suggestions:not(.hidden) .suggestion-item').filter({ hasText: query }).click();
    }
    await page.getByRole('button', { name: 'Saved trips', exact: true }).click(); if (!startsOpen) await page.setViewportSize({ width: 390, height: 844 });
    const drawer = page.locator('#trips-drawer');
    await Promise.all([expect(drawer).toBeVisible(), expect(page.locator('.trip-row')).toHaveCount(0)]);
    const box = await drawer.boundingBox(); expect(box && box.y <= 60 && box.y + box.height >= 828).toBe(true);
    await Promise.all([expect(planner).toBeHidden(), expect(fab).toBeHidden()]);
    await page.locator('#trips-drawer [data-close]').focus(); for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab'); expect(await page.evaluate(() => Boolean(document.activeElement?.closest('#planner-panel, #sheet-open'))), `tab ${i}`).toBe(false);
    }
    const planFocused = await page.locator('.planner-go').evaluate(element => { element.focus(); return document.activeElement === element; }); if (planFocused) await page.keyboard.press('Enter');
    expect(planFocused).toBe(false); expect(planRequests()).toBe(0);
    await page.locator('#trips-drawer [data-close]').focus(); await page.keyboard.press('Escape');
    await Promise.all([expect(drawer).toBeHidden(), expect(page.locator('#trips-button')).toBeFocused()]);
    if (startsOpen) await Promise.all([expect(planner).toBeVisible(), expect(fab).toBeHidden(), expect(fab).toHaveAttribute('aria-expanded', 'true')]);
    else await Promise.all([expect(planner).toBeHidden(), expect(fab).toBeVisible(), expect(fab).toHaveAttribute('aria-expanded', 'false')]);
  });
}
