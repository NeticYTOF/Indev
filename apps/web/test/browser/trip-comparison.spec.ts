import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function blockOutside(page: Page): Promise<void> {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
}

const savedTrips = [
  {
    id: 'compare-a', name: 'Delhi to Jaipur', createdAt: '2026-11-20T10:00:00Z',
    source: 'live', status: 'ok',
    origin: { label: 'Delhi', lat: 28.6139, lon: 77.209 },
    destination: { label: 'Jaipur', lat: 26.9124, lon: 75.7873 },
    vehicle: {
      label: 'Harrier 75.01', catalogId: 'custom',
      batteryKwh: 75.01, claimedRangeKm: 627, realWorldRangeKm: 300,
    },
    routeDistanceKm: 400.2, routeDurationMin: 400,
    geometry: [[28.6139, 77.209], [27, 76], [26.9124, 75.7873]],
    stations: [{
      stationId: 42, name: 'DC stop', lat: 27, lon: 76,
      chainageKm: 200, legKm: 202, detourKm: 2,
      arriveSocPct: 25, leaveSocPct: 80, chargeKwh: 41.25,
      pricePerKwh: 0, estPriceInr: 0, chargeTimeMin: 45,
    }],
    totals: {
      distanceKm: 400, driveTimeMin: 340, totalTimeMin: 400, chargeTimeMin: 45,
      chargeKwh: 41.25, estPriceInr: 0, finalSocPct: 12,
    },
  },
  {
    id: 'compare-b', name: 'Delhi to Agra', createdAt: '2026-11-20T11:00:00Z',
    source: 'synthetic', status: 'degraded',
    origin: { label: 'Delhi', lat: 28.6139, lon: 77.209 },
    destination: { label: 'Agra', lat: 27.1767, lon: 78.0081 },
    vehicle: {
      label: 'Alternative', catalogId: null,
      batteryKwh: 75, claimedRangeKm: null, realWorldRangeKm: 280,
    },
    routeDistanceKm: 420, routeDurationMin: 465,
    geometry: [[28.6139, 77.209], [27.1767, 78.0081]],
    stations: [],
    totals: {
      distanceKm: 420, driveTimeMin: 350, totalTimeMin: 465, chargeTimeMin: 60,
      chargeKwh: 48, estPriceInr: 180, finalSocPct: 18,
    },
  },
];

test('two saved trips can be compared without mutating or fetching new data', async ({ page }) => {
  await blockOutside(page);
  let tripReads = 0;
  const forbidden = new Set<string>();
  await page.route('**/api/trips', (route) => {
    tripReads++;
    if (route.request().method() !== 'GET') forbidden.add('trip write');
    return route.fulfill({ json: { trips: savedTrips } });
  });
  for (const path of ['**/api/plan', '**/api/ai/plan', '**/api/jobs/plan*', '**/api/geocode*', '**/api/stations/*']) {
    await page.route(path, (route) => {
      forbidden.add(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 500, body: 'unexpected comparison request' });
    });
  }
  await page.goto('/');
  await page.locator('#trips-button').click();
  const compare = page.locator('[data-compare-selected]');
  await expect(compare).toBeDisabled();
  await page.locator('[data-compare-toggle]').nth(0).click();
  await page.locator('[data-compare-toggle]').nth(1).click();
  await expect(compare).toHaveText('Compare selected (2/2)');
  await compare.click();

  const workspace = page.locator('[data-trip-compare]');
  await expect(workspace).toBeVisible();
  await expect(page.locator('.compare-card')).toHaveCount(2);
  await expect(page.locator('[data-compare-card="a"]')).toContainText('75.01 kWh');
  await expect(page.locator('[data-compare-card="a"]')).toContainText('300 km');
  await expect(page.locator('[data-compare-card="b"]')).toContainText('280 km');
  const deltaRow = (label: string) => page.locator('.compare-table tbody tr', { has: page.locator(`th:text-is("${label}")`) });
  await expect(deltaRow('Route distance').locator('.compare-delta')).toHaveText('+19.8 km');
  await expect(deltaRow('Total time').locator('.compare-delta')).toHaveText('+1 h 5 min');
  await expect(deltaRow('Known cost').locator('.compare-delta')).toHaveText('+Rs. 180');
  await expect(deltaRow('Destination charge').locator('.compare-delta')).toHaveText('+6 pp');
  await expect(workspace).toContainText('Synthetic');
  await expect(workspace).toContainText('Degraded');
  await expect(workspace).toContainText('No automatic best route');
  await page.getByRole('button', { name: 'Swap A and B', exact: true }).click();
  await expect(page.locator('[data-compare-card="a"]')).toContainText('Delhi to Agra');
  await expect(page.getByRole('button', { name: 'Swap A and B', exact: true })).toBeFocused();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download comparison', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('indev-saved-trip-comparison.html');
  expect([...forbidden]).toEqual([]);
  expect(tripReads).toBe(1);
});

test('comparison controls return focus and preserve only the remaining selection', async ({ page }) => {
  await blockOutside(page);
  await page.route('**/api/trips', (route) => route.fulfill({ json: { trips: savedTrips } }));
  await page.goto('/');
  await page.locator('#trips-button').click();
  const row = (name: string) => page.locator('.trip-row').filter({ hasText: name });
  await row('Delhi to Jaipur').getByRole('button', { name: 'Select to compare' }).click();
  await row('Delhi to Agra').getByRole('button', { name: 'Select to compare' }).click();
  await page.locator('[data-compare-selected]').click();
  await expect(page.locator('#trips-drawer')).toBeHidden();
  await expect(page.locator('#trips-button')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('[data-compare-remove="A"]').click();
  await expect(page.locator('#trips-drawer')).toBeVisible();
  await expect(page.locator('#trips-button')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-compare-selected]')).toBeDisabled();
  await expect(page.locator('[data-compare-selected]')).toHaveText('Compare selected (1/2)');
  await expect(page.locator('[data-compare-toggle]').first()).toBeFocused();
  await row('Delhi to Jaipur').getByRole('button', { name: 'Select to compare' }).click();
  await page.locator('[data-compare-selected]').click();
  await expect(page.locator('#trips-drawer')).toBeHidden();
  await expect(page.locator('#trips-button')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('[data-compare-clear]').click();
  await expect(page.locator('#trips-drawer')).toBeVisible();
  await expect(page.locator('#trips-button')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-compare-selected]')).toHaveText('Compare selected (0/2)');
  await expect(page.locator('[data-compare-toggle]').first()).toBeFocused();
});

test('Escape returns to saved trips and keeps the comparison ready to reopen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await blockOutside(page);
  await page.route('**/api/trips', (route) => route.fulfill({ json: { trips: savedTrips } }));
  await page.goto('/');
  await page.locator('#trips-button').click();
  await page.locator('[data-compare-toggle]').nth(0).click();
  await page.locator('[data-compare-toggle]').nth(1).click();
  await page.locator('[data-compare-selected]').click();
  await expect(page.locator('#trips-drawer')).toBeHidden();
  await expect(page.locator('#trips-button')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.compare-context')).toContainText('Units: km, minutes, kWh, INR and %');
  await page.keyboard.press('Escape');
  await expect(page.locator('#trips-drawer')).toBeVisible();
  await expect(page.locator('#trips-button')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-compare-selected]')).toHaveText('Compare selected (2/2)');
  await expect(page.locator('[data-compare-selected]')).toBeEnabled();
  await expect(page.locator('#planner-panel')).toHaveClass(/open/);
  await expect(page.locator('#sheet-open')).toBeHidden();
  await expect(page.locator('[data-compare-selected]')).toBeFocused();
  await page.locator('[data-compare-selected]').click();
  await expect(page.locator('#trips-drawer')).toBeHidden();
  await expect(page.locator('#trips-button')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-trip-compare]')).toBeVisible();
});

test('saved comparison stacks cards at mobile width without horizontal page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await blockOutside(page);
  await page.route('**/api/trips', (route) => route.fulfill({ json: { trips: savedTrips } }));
  await page.goto('/');
  await page.locator('#trips-button').click();
  await page.locator('[data-compare-toggle]').nth(0).click();
  await page.locator('[data-compare-toggle]').nth(1).click();
  await page.locator('[data-compare-selected]').click();
  const boxes = await page.locator('.compare-grid > *').evaluateAll((nodes) =>
    nodes.map((node) => { const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y }; }));
  expect(boxes).toHaveLength(3);
  expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y);
  expect(boxes[2]!.y).toBeGreaterThan(boxes[1]!.y);
  expect(Math.abs(boxes[0]!.x - boxes[1]!.x)).toBeLessThan(2);
  expect(Math.abs(boxes[1]!.x - boxes[2]!.x)).toBeLessThan(2);
  expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
