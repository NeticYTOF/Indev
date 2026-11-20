import { expect, test } from '@playwright/test';

function savedTrip(id: string, name: string, source: unknown, status: unknown, createdAt: string, origin: string, destination: string) {
  return {
    id, name, source, status, createdAt,
    origin: { label: origin, lat: 28.6, lon: 77.2 },
    destination: { label: destination, lat: 26.9, lon: 75.8 },
    routeDistanceKm: 280, routeDurationMin: 270,
    geometry: [[28.6, 77.2], [26.9, 75.8]],
    vehicle: { label: 'Fixture EV' },
    totals: { totalTimeMin: 210, chargeTimeMin: 20, finalSocPct: 25 },
    stations: [],
  };
}

test('combined provenance filters preserve identity, hidden selection and clear recovery', async ({ page }, info) => {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  const unexpected: string[] = [];
  for (const path of ['**/api/plan', '**/api/ai/plan', '**/api/geocode*', '**/api/stations/*']) {
    await page.route(path, (route) => {
      unexpected.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 500, body: 'unexpected request' });
    });
  }
  const trips = [
    savedTrip('yankee', 'Yankee', 'live', 'ok', '2026-01-03T00:00:00Z', 'Delhi', 'Jaipur'),
    savedTrip('beta', 'Beta', 'synthetic', 'degraded', '2026-01-01T00:00:00Z', 'Pune', 'Goa'),
    savedTrip('zulu', 'Zulu', 'live', 'degraded', '2026-01-02T00:00:00Z', 'Chennai', 'Mumbai'),
    savedTrip('ghost', 'Ghost', null, 'malformed', '2026-01-04T00:00:00Z', 'Agra', 'Delhi'),
  ];
  let tripReads = 0;
  let tripWrites = 0;
  await page.route('**/api/trips', (route) => {
    if (route.request().method() === 'GET') tripReads += 1;
    else tripWrites += 1;
    return route.fulfill({ json: { trips } });
  });
  await page.goto('/');
  await page.locator('#trips-button').click();
  await expect(page.locator('[data-trip-result-count]')).toHaveText('Showing 4 of 4 saved trips.');

  await page.locator('[data-trip-source]').selectOption('live');
  await page.locator('[data-trip-status]').selectOption('degraded');
  await page.locator('[data-trip-sort]').selectOption('name');
  await page.locator('[data-trip-search]').fill('mumbai');
  await expect(page.locator('.trip-row .trip-name')).toHaveText(['Zulu']);
  await expect(page.locator('.trip-row [data-compare-toggle]')).toHaveAttribute('data-compare-index', '2');
  await expect(page.locator('[data-trip-result-count]')).toHaveText('Showing 1 of 4 saved trips.');
  await page.locator('.trip-row [data-compare-toggle]').click();
  await expect(page.locator('[data-compare-selected]')).toHaveText('Compare selected (1/2)');

  for (const selector of ['[data-trip-source]', '[data-trip-status]']) {
    const box = await page.locator(selector).evaluate((select) => ({
      width: select.getBoundingClientRect().width,
      parent: select.parentElement?.getBoundingClientRect().width ?? 0,
      scroll: select.scrollWidth,
      client: select.clientWidth,
    }));
    expect(box.width).toBeGreaterThan(box.parent * 0.7);
    expect(box.scroll).toBeLessThanOrEqual(box.client + 1);
  }
  await page.screenshot({ path: info.outputPath('saved-trip-filters-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('saved-trip-filters-mobile.png') });

  await page.locator('[data-trip-source]').selectOption('synthetic');
  await page.locator('[data-trip-status]').selectOption('ok');
  await expect(page.locator('.trip-list')).toContainText('No saved trips match the current filters.');
  await expect(page.locator('.hidden-selection-notice')).toContainText('1 selected trip hidden');
  await page.locator('[data-trip-filters-clear]').click();
  await expect(page.locator('[data-trip-search]')).toHaveValue('');
  await expect(page.locator('[data-trip-source]')).toHaveValue('all');
  await expect(page.locator('[data-trip-status]')).toHaveValue('all');
  await expect(page.locator('[data-trip-result-count]')).toHaveText('Showing 4 of 4 saved trips.');
  await expect(page.locator('[data-trip-search]')).toBeFocused();
  await expect(page.locator('.hidden-selection-notice')).toBeHidden();
  await page.locator('[data-trip-source]').selectOption('unknown');
  await page.locator('[data-trip-status]').selectOption('unknown');
  await expect(page.locator('.trip-row')).toHaveCount(1);
  await expect(page.locator('.trip-row')).toContainText('source unknown');
  await expect(page.locator('.trip-row')).toContainText('status unknown');
  expect(tripReads).toBe(1);
  expect(tripWrites).toBe(0);
  expect(unexpected).toEqual([]);
});

test('provenance filters survive reopen and delete refresh without restoring selection', async ({ page }) => {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  let trips = [
    savedTrip('yankee', 'Yankee', 'live', 'ok', '2026-01-03T00:00:00Z', 'Delhi', 'Jaipur'),
    savedTrip('zulu', 'Zulu', 'live', 'degraded', '2026-01-02T00:00:00Z', 'Chennai', 'Mumbai'),
  ];
  let deletePath: string | null = null;
  await page.route('**/api/trips', (route) => route.fulfill({ json: { trips } }));
  await page.route('**/api/trips/*', async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    deletePath = new URL(route.request().url()).pathname;
    trips = trips.filter((trip) => trip.id !== 'zulu');
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  await page.locator('#trips-button').click();
  await page.locator('[data-trip-source]').selectOption('live');
  await page.locator('[data-trip-status]').selectOption('degraded');
  await page.locator('[data-trip-sort]').selectOption('name');
  await expect(page.locator('[data-trip-result-count]')).toHaveText('Showing 1 of 2 saved trips.');
  await page.locator('.trip-row [data-compare-toggle]').click();
  await page.locator('[data-close]').click();
  await page.locator('#trips-button').click();
  await expect(page.locator('[data-trip-source]')).toHaveValue('live');
  await expect(page.locator('[data-trip-status]')).toHaveValue('degraded');
  await expect(page.locator('[data-trip-sort]')).toHaveValue('name');
  await expect(page.locator('[data-compare-selected]')).toHaveText('Compare selected (0/2)');

  await page.locator('.trip-row').filter({ hasText: 'Zulu' })
    .getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => deletePath).toBe('/api/trips/zulu');
  await expect(page.locator('[data-trip-source]')).toHaveValue('live');
  await expect(page.locator('[data-trip-status]')).toHaveValue('degraded');
  await expect(page.locator('[data-trip-result-count]')).toHaveText('Showing 0 of 1 saved trips.');
  await expect(page.locator('.trip-list')).toContainText('No saved trips match the current filters.');
  await expect(page.locator('.hidden-selection-notice')).toBeHidden();
});
