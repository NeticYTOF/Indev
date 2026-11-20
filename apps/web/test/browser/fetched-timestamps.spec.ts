import { expect, test } from '@playwright/test';

const fetchedAt = '2025-02-03T10:15:00Z';
for (const saved of [false, true]) {
  test(`${saved ? 'saved' : 'fresh'} station refresh shows source timestamp, not permanent just now`, async ({ page }) => {
    await page.route(/^https?:\/\//, async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
      else await route.abort();
    });
    await page.route('**/api/trips', (route) => route.fulfill({ json: { trips: [{
      id: 'fixture', name: 'Fixture', source: 'synthetic', createdAt: fetchedAt,
      origin: { label: 'Delhi', lat: 28, lon: 77 }, destination: { label: 'Jaipur', lat: 27, lon: 76 },
      geometry: [[28, 77], [27, 76]], routeDistanceKm: 285, vehicle: { label: 'Fixture EV' },
      totals: { totalTimeMin: 200, chargeTimeMin: 20, finalSocPct: 25 },
      stations: [{ stationId: 1, name: 'Fixture station', lat: 27.5, lon: 76.5 }],
    }] } }));
    await page.route('**/api/stations/*', (route) => route.fulfill({ json: { station: {
      stationId: 1, fetchedAt, synthetic: true, rating: 4, reviewCount: 5, reliability: null, chargers: [],
      ccs2: { usable: 2, free: 1, faulted: 0, uncertain: 0 },
    } } }));
    await page.route('**/api/plan', async (route) => {
      const response = await route.fetch(); const body = await response.json();
      for (const stop of body.plan.stops) stop.station.fetchedAt = fetchedAt;
      await route.fulfill({ json: body });
    });
    await page.goto('/');
    if (saved) {
      await page.locator('#trips-button').click();
      await page.getByRole('button', { name: 'Open', exact: true }).click();
    } else {
      for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
        await page.getByRole('searchbox', { name, exact: true }).fill(query!);
        await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
      }
      await page.locator('.planner-go').click();
      await expect(page.locator('.stop-card').first().locator('.fetched')).toContainText('3 Feb 2025');
    }
    const card = page.locator('.stop-card').first();
    await card.getByRole('button', { name: saved ? 'Fetch current details' : 'Revalidate', exact: true }).click();
    await expect(card.locator('.revalidate-box .fetched')).toContainText('3 Feb 2025');
    await expect(card.locator('.revalidate-box .fetched')).not.toContainText('just now');
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('fetched-timestamp.png') });
  });
}
