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
