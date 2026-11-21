import { expect, test } from '@playwright/test';

const warning = 'Storage operation completed, but its writer lock could not be released. Do not retry the operation; stop all writers before manual recovery.';

for (const action of ['save', 'delete'] as const) {
  test(`${action} shows a persistent cleanup warning without losing the known outcome`, async ({ page }, info) => {
    await page.setViewportSize(action === 'save' ? { width: 390, height: 844 } : { width: 1280, height: 800 });
    let writes = 0;
    let deleted = false;
    await page.route(/^https?:\/\//, async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
      else await route.abort();
    });
    await page.route('**/api/trips', async route => {
      if (route.request().method() === 'POST') {
        writes++;
        await route.fulfill({ status: 201, json: { trip: { id: 'saved-fixture' }, warnings: [warning], storage: { committed: true, lockReleased: false } } });
      } else {
        await route.fulfill({ json: { trips: deleted ? [] : [{ id: 'fixture', name: 'Fixture', origin: { label: 'Delhi' }, destination: { label: 'Jaipur' }, routeDistanceKm: 285, stations: [], totals: { totalTimeMin: 200 } }] } });
      }
    });
    await page.route('**/api/trips/fixture', async route => {
      writes++; deleted = true;
      await route.fulfill({ json: { ok: true, warnings: [warning], storage: { committed: true, lockReleased: false } } });
    });
    await page.goto('/');
    if (action === 'save') {
      for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
        await page.getByRole('combobox', { name, exact: true }).fill(query!);
        await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
      }
      await page.getByRole('button', { name: 'Plan route', exact: true }).click();
      const button = page.locator('[data-save]'); await button.click();
      await expect(button).toHaveText('Saved to your trips'); await expect(button).toBeDisabled();
      await button.evaluate(element => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    } else {
      await page.locator('#trips-button').click();
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(page.locator('.trip-row')).toHaveCount(0);
    }
    const banner = page.locator('[data-storage-warning]');
    await expect(banner).toContainText(action === 'save' ? 'Trip saved.' : 'Trip deleted.');
    await expect(banner).toContainText('Do not retry'); await banner.scrollIntoViewIfNeeded();
    await expect(banner).toBeVisible(); await expect.poll(() => writes).toBe(1);
    await page.screenshot({ path: info.outputPath(`${action}-storage-warning.png`) });
    // The warning is in the page, not only in an expiring toast.
    await page.locator('#toast-root').evaluate(element => element.replaceChildren());
    await expect(banner).toBeVisible(); expect(writes).toBe(1);
  });
}
