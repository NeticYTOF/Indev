import { expect, test } from '@playwright/test';

function savedTrip(id: string, name: string, origin: string, destination: string, createdAt: string) {
  return {
    id, name, createdAt,
    origin: { label: origin, lat: 28.6, lon: 77.2 },
    destination: { label: destination, lat: 26.9, lon: 75.8 },
    vehicle: {
      label: 'Fixture EV', catalogId: null, batteryKwh: 72,
      claimedRangeKm: 480, realWorldRangeKm: 320,
    },
    status: 'ok', source: 'live', routeDistanceKm: 280, routeDurationMin: 270,
    geometry: [[28.6, 77.2], [26.9, 75.8]],
    stations: [{ stationId: 42, name: 'Original stop', lat: 27.5, lon: 76.5 }],
    totals: {
      distanceKm: 280, driveTimeMin: 250, totalTimeMin: 270, chargeTimeMin: 20,
      chargeKwh: 30, estPriceInr: 240, finalSocPct: 18,
    },
  };
}

test('filtered and sorted Return trip loads a manual return draft without requests', async ({ page }, info) => {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  const unexpected: string[] = [];
  for (const path of ['**/api/plan', '**/api/ai/plan', '**/api/jobs/plan*', '**/api/geocode*', '**/api/stations/*']) {
    await page.route(path, (route) => {
      unexpected.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 500, body: 'unexpected request' });
    });
  }
  await page.route('**/api/health', (route) => route.fulfill({ json: { ok: true, mock: true, ai: true, chargersSeen: 0 } }));
  await page.route('**/api/vehicles', (route) => route.fulfill({ json: { default: null, catalog: [] } }));
  const trips = [
    savedTrip('yankee', 'Yankee', 'Delhi', 'Jaipur', '2026-01-03T00:00:00Z'),
    savedTrip('beta', 'Beta', 'Pune', 'Goa', '2026-01-01T00:00:00Z'),
    savedTrip('zulu', 'Zulu', 'Chennai', 'Mumbai', '2026-01-02T00:00:00Z'),
  ];
  const snapshot = JSON.stringify(trips);
  let tripWrites = 0;
  await page.route('**/api/trips', (route) => {
    if (route.request().method() !== 'GET') tripWrites += 1;
    return route.fulfill({ json: { trips } });
  });
  await page.goto('/');
  await page.locator('#trips-button').click();
  await page.locator('[data-trip-sort]').selectOption('name');
  await page.locator('[data-trip-search]').fill('goa');
  await expect(page.locator('.trip-row .trip-name')).toHaveText(['Beta']);
  await page.locator('.trip-row').filter({ hasText: 'Beta' })
    .getByRole('button', { name: 'Return trip', exact: true }).click();

  await expect(page.getByRole('combobox', { name: 'From', exact: true })).toHaveValue('Goa');
  await expect(page.getByRole('combobox', { name: 'To', exact: true })).toHaveValue('Pune');
  await expect(page.locator('.review-title')).toContainText('New return-direction plan');
  await expect(page.locator('.saved-route-review')).toContainText('Saved stops, geometry, totals and any previous results were not reversed or reused');
  await expect(page.locator('.saved-route-review')).toContainText('Start charge, charging reserve');
  await expect(page.getByRole('combobox', { name: 'From', exact: true })).toBeFocused();
  await expect(page.locator('.plan-results')).toHaveCount(0);
  expect(JSON.stringify(trips)).toBe(snapshot);
  expect(tripWrites).toBe(0);
  expect(unexpected).toEqual([]);
  await page.screenshot({ path: info.outputPath('saved-return-review-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('saved-return-review-mobile.png') });
});

test('saved summary Return clears the forward map and results before review', async ({ page }) => {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('https://tiles.openfreemap.org/styles/dark', (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background' }] },
  }));
  const unexpected: string[] = [];
  for (const path of ['**/api/plan', '**/api/ai/plan', '**/api/jobs/plan*', '**/api/geocode*', '**/api/stations/*']) {
    await page.route(path, (route) => {
      unexpected.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 500, body: 'unexpected request' });
    });
  }
  await page.route('**/api/health', (route) => route.fulfill({ json: { ok: true, mock: true, ai: true, chargersSeen: 0 } }));
  await page.route('**/api/vehicles', (route) => route.fulfill({ json: { default: null, catalog: [] } }));
  const trip = savedTrip('yankee', 'Yankee', 'Delhi', 'Jaipur', '2026-01-03T00:00:00Z');
  const snapshot = JSON.stringify(trip);
  await page.route('**/api/trips', (route) => route.fulfill({ json: { trips: [trip] } }));
  await page.goto('/');
  await page.locator('#trips-button').click();
  await page.locator('.trip-row').filter({ hasText: 'Yankee' })
    .getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('.pin-origin')).toHaveCount(1);
  await expect(page.locator('.stop-marker')).toHaveCount(1);
  await expect(page.locator('.plan-results')).toContainText('Jaipur');

  await page.locator('[data-return-saved]').click();
  await expect(page.locator('.pin-origin')).toHaveCount(0);
  await expect(page.locator('.pin-destination')).toHaveCount(0);
  await expect(page.locator('.stop-marker')).toHaveCount(0);
  await expect(page.locator('.plan-results')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'From', exact: true })).toHaveValue('Jaipur');
  await expect(page.getByRole('combobox', { name: 'To', exact: true })).toHaveValue('Delhi');
  await expect(page.locator('.review-title')).toContainText('New return-direction plan');
  await expect(page.getByRole('combobox', { name: 'From', exact: true })).toBeFocused();
  expect(JSON.stringify(trip)).toBe(snapshot);
  expect(unexpected).toEqual([]);
});
