import { expect, test } from '@playwright/test';

test('new saves reject string ranges and legacy values stay literal when opened', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(/^https?:\/\//, async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  const planned = await page.request.post('/api/plan', { data: {
    origin: { label: 'Delhi', lat: 28.6139, lon: 77.209 },
    destination: { label: 'Jaipur', lat: 26.9124, lon: 75.7873 },
  } });
  expect(planned.ok()).toBe(true);
  const { plan } = await planned.json();
  const ordinary = await page.request.post('/api/trips', { data: { plan, name: 'Legacy scalar fixture' } });
  expect(ordinary.status()).toBe(201);
  const { trip } = await ordinary.json();
  const realRange = '<span data-range-proof>local marker</span>';
  const claimRange = '<b data-claim-proof>old claim</b>';
  plan.vehicle.realWorldRangeKm = realRange;
  const rejected = await page.request.post('/api/trips', { data: { plan, name: 'Rejected string range' } });
  expect(rejected.status()).toBe(400);
  const unchanged = await page.request.get('/api/trips');
  expect((await unchanged.json()).trips).toHaveLength(1);

  // Existing snapshots are not migrated or rewritten. Exercise the renderer
  // independently of new-write validation with a simulated historical record.
  trip.vehicle.realWorldRangeKm = realRange;
  trip.vehicle.claimedRangeKm = claimRange;
  trip.stations[0].stationId = '7" data-station-attribute-proof="local-marker';
  delete trip.status; delete trip.source;
  await page.route('**/api/trips', route => route.fulfill({ json: { trips: [trip] } }));
  await page.goto('/'); await page.locator('#trips-button').click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  const vehicle = page.locator('.plan-results .plan-vehicle');
  await expect(vehicle).toContainText('your real-world range Unknown');
  await expect(vehicle).toContainText('claim Unknown');
  await expect(vehicle).toContainText('legacy stored real-world text:');
  await expect(vehicle).toContainText('legacy stored claim text:');
  await expect(vehicle).toContainText(realRange); await expect(vehicle).toContainText(claimRange);
  await expect(page.locator('[data-range-proof], [data-claim-proof], [data-station-attribute-proof]')).toHaveCount(0);
  await expect(page.locator('.saved-stop').first()).toHaveAttribute('data-station-id', 'Unknown');
  await expect(page.locator('.saved-stop').first().getByRole('button', { name: 'Fetch unavailable — station id Unknown' })).toBeDisabled();
  await vehicle.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('saved-metadata-literal.png') });
});
