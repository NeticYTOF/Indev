import { expect, test } from '@playwright/test';

for (const moved of [false, true]) {
  test(`delete completion ${moved ? 'preserves deliberate planner focus' : 'restores normal drawer context'}`, async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let deleted = false;
    await page.route(/^https?:\/\//, async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
      else await route.abort();
    });
    await page.route('**/api/trips', (route) => route.fulfill({ json: { trips: deleted ? [] : [{
      id: 'fixture', name: 'Fixture', origin: { label: 'Delhi' }, destination: { label: 'Jaipur' },
      routeDistanceKm: 285, stations: [], totals: { totalTimeMin: 200 },
    }] } }));
    await page.route('**/api/trips/fixture', async (route) => {
      expect(route.request().method()).toBe('DELETE');
      await held; deleted = true; await route.fulfill({ json: { ok: true } });
    });
    await page.goto('/');
    await page.locator('#trips-button').click();
    const button = page.getByRole('button', { name: 'Delete', exact: true });
    await button.click();
    await expect(button).toBeDisabled();
    const field = page.getByRole('searchbox', { name: 'From', exact: true });
    if (moved) {
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await field.focus();
    }
    release();
    await expect(page.locator('.trip-row')).toHaveCount(0);
    if (moved) {
      await expect(field).toBeFocused();
      await expect(page.locator('#trips-drawer')).toBeHidden();
    } else await expect(page.locator('#trips-button')).toBeFocused();
  });
}
