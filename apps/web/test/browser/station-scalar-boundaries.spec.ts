import { expect, test } from '@playwright/test';

async function blockOutside(page: import('@playwright/test').Page) {
  await page.route(/^https?:\/\//, async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
}
const places = { origin: { label: 'Delhi', lat: 28.6139, lon: 77.209 }, destination: { label: 'Jaipur', lat: 26.9124, lon: 75.7873 } };

test('invalid review counts remain unknown in plan and both revalidation views', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await blockOutside(page);
  const marker = '<span data-review-proof>Harmless count marker</span>';
  await page.route('**/api/plan', async route => {
    const response = await route.fetch(); const body = await response.json();
    body.plan.stops[0].station.reviewCount = marker;
    body.plan.stops[0].station.stationUrl = 42;
    body.plan.stops[1].station.reviewCount = 0;
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/stations/*', async route => {
    const response = await route.fetch(); const body = await response.json();
    body.station.reviewCount = marker; await route.fulfill({ response, json: body });
  });
  await page.goto('/');
  for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
    await page.getByRole('searchbox', { name, exact: true }).fill(query!);
    await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
  }
  await page.getByRole('button', { name: 'Plan route', exact: true }).click();
  const first = page.locator('.stop-card').first();
  await expect(first).toContainText('unknown reviews');
  await expect(page.locator('.stop-card').nth(1)).toContainText('0 reviews');
  await expect(first.getByRole('link', { name: 'Station page', exact: true })).toHaveCount(0);
  await page.locator('[data-refresh]').first().click();
  await expect(first.locator('.revalidate-box')).toContainText('unknown reviews');
  await expect(page.locator('[data-review-proof]')).toHaveCount(0);
  await page.locator('[data-save]').click(); await expect(page.locator('[data-save]')).toHaveText('Saved to your trips');
  await page.locator('#trips-button').click(); await page.getByRole('button', { name: 'Open', exact: true }).first().click();
  await page.getByRole('button', { name: 'Fetch current details', exact: true }).first().click();
  const box = page.locator('.saved-stop').first().locator('.revalidate-box');
  await expect(box).toContainText('unknown reviews');
  await expect(page.locator('[data-review-proof]')).toHaveCount(0);
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('station-review-unknown.png') });
});

test('a missing stop list stays Unknown and suppresses directions instead of a direct route', async ({ page }) => {
  await blockOutside(page);
  const response = await page.request.post('/api/plan', { data: places });
  const { plan } = await response.json();
  delete plan.stops;
  plan.origin.label = null;
  plan.destination.label = 42;
  await page.goto('/');
  await page.evaluate(async (plan) => {
    const module = await import('/src/plan-panel.ts');
    module.renderPlanPanel(document.getElementById('planner-panel'), null, plan);
  }, plan);
  await expect(page.locator('.plan-results')).toContainText('Charging stop list is Unknown');
  await expect(page.locator('.no-stops')).toHaveCount(0);
  await expect(page.locator('.plan-results')).not.toContainText('No charging stops needed');
  await expect(page.locator('.origin')).toHaveText('Unknown');
  await expect(page.locator('[data-gmaps]')).toHaveCount(0);
  await expect(page.locator('.plan-actions')).toContainText('Google Maps directions unavailable');
});

test('a non-array saved trip payload is reported unavailable, not empty', async ({ page }) => {
  await blockOutside(page);
  await page.route('**/api/trips', (route) => route.fulfill({ json: { trips: { unexpected: true } } }));
  await page.goto('/');
  await page.evaluate(async () => {
    const module = await import('/src/trips.ts');
    module.renderTripsDrawer(document.getElementById('trips-drawer'), null, () => true);
  });
  await expect(page.locator('.trip-list')).toContainText('Saved trip list is unavailable');
  await expect(page.locator('.trip-list')).not.toContainText('No saved trips yet');
});

test('invalid saved geometry is omitted whole and never trimmed into a route', async ({ page }) => {
  await blockOutside(page);
  const trip = {
    id: 'bad-geometry', name: 'Bad geometry', createdAt: '2026-01-01T00:00:00.000Z',
    source: 'live', status: 'ok',
    origin: { label: 'Origin', lat: 28, lon: 77 },
    destination: { label: 'Destination', lat: 26, lon: 75 },
    geometry: [[28, 77], [null, 78], [26, 75]],
    stations: [{
      stationId: 0, name: 'Invalid id stop', lat: 27, lon: 76,
      chainageKm: 280, legKm: 282, detourKm: 2,
      arriveSocPct: 20, leaveSocPct: 80, chargeKwh: 42.7, pricePerKwh: 20,
      estPriceInr: 854, chargeTimeMin: 42,
    }],
    totals: {
      distanceKm: 600, driveTimeMin: 400, chargeTimeMin: 42, totalTimeMin: 442,
      chargeKwh: 42.7, estPriceInr: 854, finalSocPct: 12,
    },
  };
  await page.route('**/api/trips', (route) => route.fulfill({ json: { trips: [trip] } }));
  await page.goto('/');
  await page.evaluate(async () => {
    const module = await import('/src/trips.ts');
    module.renderTripsDrawer(document.getElementById('trips-drawer'), null, () => true);
  });
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('.plan-results')).toContainText('no map route was drawn');
  await expect(page.locator('.plan-results')).not.toContainText('Charging stops 0');
  await expect(page.locator('.saved-stop')).toHaveCount(1);
  await expect(page.locator('.saved-stop')).toHaveAttribute('data-station-id', 'Unknown');
  await expect(page.locator('.saved-stop [data-revalidate]')).toBeDisabled();
  await expect(page.locator('[data-journey-briefing]')).toBeVisible();
});

test('valid saved [lat, lon] tuple geometry draws the route while a missing stop list stays Unknown', async ({ page }) => {
  await blockOutside(page);
  await page.route('https://tiles.openfreemap.org/styles/dark', (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background' }] },
  }));
  const trip = {
    id: 'tuple-geometry', name: 'Tuple geometry', createdAt: '2026-01-01T00:00:00.000Z',
    source: 'live', status: 'ok',
    origin: { label: 'Origin A', lat: 28, lon: 77 },
    destination: { label: 'Destination B', lat: 26, lon: 75 },
    geometry: [[28, 77], [27, 76], [26, 75]],
    totals: {
      distanceKm: 600, driveTimeMin: 400, chargeTimeMin: 0, totalTimeMin: 400,
      chargeKwh: 0, estPriceInr: null, finalSocPct: 20,
    },
  };
  await page.route('**/api/trips', (route) => route.fulfill({ json: { trips: [trip] } }));
  await page.goto('/');
  await page.locator('#trips-button').click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('.pin-origin')).toHaveCount(1);
  await expect(page.locator('.pin-destination')).toHaveCount(1);
  await expect(page.locator('.stop-marker')).toHaveCount(0);
  await expect(page.locator('.plan-results')).toContainText('Stored stop list is Unknown');
  await expect(page.locator('.plan-results')).not.toContainText('Charging stops 0');
  await expect(page.locator('.plan-results')).not.toContainText('no map route was drawn');
});

test('stop-card component omits Directions for malformed coordinates and preserves valid links', async ({ page }, info) => {
  await blockOutside(page);
  const response = await page.request.post('/api/plan', { data: places }); const { plan } = await response.json();
  plan.stops[0].station.lat = '28" data-location-proof="local-marker';
  await page.goto('/');
  // Component boundary test only. Invalid coordinates are intentionally not
  // sent to MapLibre; this does not claim upstream planning validation.
  await page.evaluate(async plan => {
    const modulePath = '/src/plan-panel.ts'; const module = await import(modulePath);
    module.renderPlanPanel(document.getElementById('planner-panel'), null, plan);
  }, plan);
  const first = page.locator('.stop-card').first(), second = page.locator('.stop-card').nth(1);
  await expect(first).toContainText('Directions unavailable');
  await expect(first.getByRole('link', { name: 'Directions', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-location-proof]')).toHaveCount(0);
  await expect(page.locator('[data-gmaps]')).toHaveCount(0);
  await expect(page.locator('.plan-actions')).toContainText('Google Maps directions unavailable');
  await expect(second.getByRole('link', { name: 'Directions', exact: true })).toHaveAttribute('href', `https://www.google.com/maps/dir/?api=1&destination=${plan.stops[1].station.lat}%2C${plan.stops[1].station.lon}`);
  await first.scrollIntoViewIfNeeded();
  await first.screenshot({ path: info.outputPath('station-directions-unavailable.png') });
});
