import { expect, test } from '@playwright/test';

for (const failure of ['http', 'network']) {
  test(`saved station details single flight and ${failure} recovery`, async ({ page }) => {
    let lookups = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(/^https?:\/\//, async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
      else await route.abort();
    });
    await page.route('**/api/trips', (route) => route.fulfill({ json: { trips: [{
      id: 'local-fixture', name: 'Saved fixture', source: 'synthetic', createdAt: '2026-11-19T18:00:00Z',
      origin: { label: 'Delhi', lat: 28, lon: 77 }, destination: { label: 'Jaipur', lat: 27, lon: 76 },
      routeDistanceKm: 285, geometry: [[28, 77], [27, 76]], vehicle: { label: 'Fixture EV' },
      totals: { totalTimeMin: 200, chargeTimeMin: 20, finalSocPct: 25 },
      stations: [{ stationId: 1, name: 'Fixture station', lat: 27.5, lon: 76.5 }],
    }] } }));
    await page.route('**/api/stations/*', async (route) => {
      lookups++;
      if (lookups === 1) {
        await held;
        if (failure === 'network') await route.abort('failed');
        else await route.fulfill({ status: 503, json: { error: 'Synthetic temporary failure' } });
      } else await route.fulfill({ json: { station: {
        synthetic: true, rating: 4, reviewCount: 5, reliability: null, chargers: [],
        ccs2: { usable: 2, faulted: 0, uncertain: 0 },
      } } });
    });
    await page.goto('/');
    await page.locator('#trips-button').click();
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    const button = page.getByRole('button', { name: 'Fetch current details', exact: true });
    await button.focus();
    await button.press('Enter');
    await expect.poll(() => lookups).toBe(1);
    await expect(button).toBeDisabled();
    await button.evaluate((element) => { for (let n = 0; n < 4; n++) element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(lookups).toBe(1);
    release();
    await expect(page.locator('.revalidate-box')).toContainText('unavailable');
    await expect(button).toBeEnabled();
    await expect(button).toBeFocused();
    await button.click();
    await expect.poll(() => lookups).toBe(2);
    await expect(page.locator('.revalidate-box')).toContainText('2 usable CCS2 plugs');
    await expect(button).toBeEnabled();
    await page.locator('.saved-stop').scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('saved-detail-recovery.png') });
  });
}
