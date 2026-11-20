import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

interface BriefingFixturePlan {
  source: string;
  status: string;
  origin: { label: string };
  destination: { label: string };
  stops: Array<{
    station: { name: string };
    chargeKwh: number;
    chargeTimeMin: number;
    arriveSocPct: number;
    leaveSocPct: number;
    pricePerKwh: number | null;
    estPriceInr: number | null;
  }>;
  warnings: string[];
  totals: { distanceKm: number; finalSocPct: number };
}

async function planSyntheticTrip(page: import('@playwright/test').Page): Promise<BriefingFixturePlan> {
  let fixture: BriefingFixturePlan | null = null;
  await page.route('**/api/plan', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { plan: BriefingFixturePlan };
    if (body.plan.stops[0]) body.plan.stops[0].pricePerKwh = 22.75;
    fixture = body.plan;
    await route.fulfill({ response, json: body });
  });
  await page.goto('/');
  for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
    await page.getByRole('searchbox', { name, exact: true }).fill(query!);
    await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
  }
  await page.getByRole('button', { name: 'Plan route', exact: true }).click();
  await expect(page.locator('.plan-results')).toBeVisible();
  const captured = fixture;
  if (!captured) throw new Error('Plan response was not captured.');
  return captured;
}

test('itinerary export survives malformed labels and unreadable stop lists', async ({ page }) => {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  const response = await page.request.post('/api/plan', { data: {
    origin: { label: 'Delhi', lat: 28.6139, lon: 77.209 },
    destination: { label: 'Jaipur', lat: 26.9124, lon: 75.7873 },
  } });
  const { plan } = await response.json();
  plan.origin.label = null;
  plan.destination.label = 42;
  delete plan.stops;
  await page.goto('/');
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(async (plan) => {
    const module = await import('/src/journey-briefing.ts');
    module.downloadJourneyBriefing(plan);
  }, plan);
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('indeev-journey-unknown-unknown.html');
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`journey briefing presents plan facts and print view at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route(/^https?:\/\//, async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
      else await route.abort();
    });
    const plan = await planSyntheticTrip(page);
    expect(plan.source).toBe('synthetic');
    expect(plan.stops.length).toBeGreaterThan(0);

    const briefing = page.locator('[data-journey-briefing]');
    await expect(briefing).toBeVisible();
    await expect(briefing).toContainText('Journey briefing');
    await expect(briefing).toContainText('Synthetic data');
    await expect(briefing.locator('.journey-leg')).toHaveCount(plan.stops.length + 1);
    await expect(briefing.locator('.journey-leg').first()).toContainText(plan.origin.label);
    await expect(briefing.locator('.journey-leg').last()).toContainText(plan.destination.label);
    await expect(briefing.locator('[role="meter"]'))
      .toHaveCount(plan.stops.length * 2 + 1);
    await expect(briefing.locator('.briefing-itinerary tbody tr')).toHaveCount(plan.stops.length);
    const firstRow = briefing.locator('.briefing-itinerary tbody tr').first();
    const firstCost = plan.stops[0]!.estPriceInr == null
      ? 'Unknown'
      : `Rs. ${Math.round(plan.stops[0]!.estPriceInr).toLocaleString('en-IN')}`;
    await expect(briefing.locator('.briefing-summary')).toContainText(`${Math.round(plan.totals.distanceKm)} km`);
    await expect(firstRow).toContainText(plan.stops[0]!.station.name);
    await expect(firstRow).toContainText(`${Math.round(plan.stops[0]!.arriveSocPct)}%`);
    await expect(firstRow).toContainText(`${Math.round(plan.stops[0]!.leaveSocPct)}%`);
    await expect(firstRow).toContainText(`${Math.round(plan.stops[0]!.chargeKwh * 10) / 10} kWh`);
    await expect(firstRow).toContainText(`${Math.round(plan.stops[0]!.chargeTimeMin)} min`);
    await expect(firstRow).toContainText('Rs. 22.75/kWh');
    await expect(firstRow).toContainText(firstCost);

    // Existing planning, animated-export, save, and map controls remain intact.
    await expect(page.locator('[data-save]')).toBeVisible();
    await expect(page.locator('[data-export]')).toHaveText('Animated export');
    await expect(page.locator('[data-gmaps]')).toBeVisible();
    await expect(briefing.locator('.briefing-scroll')).toHaveAttribute('tabindex', '0');
    await briefing.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`journey-briefing-${viewport.width}.png`) });

    await page.emulateMedia({ media: 'print' });
    await expect(briefing).toBeVisible();
    await expect(page.locator('#map')).toBeHidden();
    await expect(page.locator('.top-cluster')).toBeHidden();
    await expect(page.locator('.planner')).toBeHidden();
    await expect(page.locator('.plan-actions')).toBeHidden();
    await expect(page.locator('.stops')).toBeHidden();
    await expect(briefing.locator('.briefing-itinerary')).toBeVisible();
    await expect(briefing.locator('.briefing-battery-value strong').first()).toHaveCSS('white-space', 'nowrap');
    await expect(briefing.locator('.journey-battery-point').first()).toHaveCSS('break-inside', 'avoid');
    await page.screenshot({
      path: test.info().outputPath(`journey-briefing-print-${viewport.width}.png`),
      fullPage: true,
    });
    await page.emulateMedia({ media: 'screen' });
  });
}

test('reopening a saved trip exposes its planned charging itinerary', async ({ page }) => {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('**/api/trips', (route) => route.fulfill({ json: { trips: [{
    id: 'saved-journey-fixture', name: 'Saved journey', source: 'synthetic',
    status: 'degraded', createdAt: '2026-11-19T18:00:00Z',
    origin: { label: 'Delhi', lat: 28, lon: 77 },
    destination: { label: 'Jaipur', lat: 27, lon: 76 },
    routeDistanceKm: 285, routeDurationMin: 270,
    geometry: [[28, 77], [27, 76]],
    vehicle: { label: 'Fixture EV', catalogId: null, batteryKwh: 75, claimedRangeKm: 627, realWorldRangeKm: null },
    totals: {
      distanceKm: 285, driveTimeMin: 270, chargeTimeMin: 42,
      totalTimeMin: 312, chargeKwh: 42.7, estPriceInr: 854, finalSocPct: 12,
    },
    stations: [{
      stationId: 42, name: 'Saved highway stop', lat: 27.5, lon: 76.5,
      chainageKm: 160, legKm: 162, detourKm: 2,
      arriveSocPct: 20, leaveSocPct: 80, chargeKwh: 42.7,
      pricePerKwh: 20, estPriceInr: 854, chargeTimeMin: 42,
    }],
  }] } }));
  await page.goto('/');
  await page.locator('#trips-button').click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();

  const briefing = page.locator('[data-journey-briefing]');
  await expect(briefing).toBeVisible();
  await expect(briefing.locator('.journey-leg')).toHaveCount(2);
  await expect(briefing.locator('.briefing-itinerary tbody tr')).toHaveCount(1);
  await expect(briefing.locator('.briefing-itinerary tbody tr')).toContainText('42.7 kWh');
  await expect(briefing.locator('.briefing-itinerary tbody tr')).toContainText('Rs. 20/kWh');
  await expect(briefing.locator('.briefing-itinerary tbody tr')).toContainText('Unknown');
  await expect(page.locator('.saved-stop').getByRole('button', { name: 'Fetch current details' })).toBeVisible();
  await expect(page.locator('[data-itinerary-export]')).toBeVisible();
  await expect(page.locator('[data-print]')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('journey-briefing-saved.png') });
});

test('downloadable itinerary is standalone, labelled, and complete', async ({ page }) => {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  const plan = await planSyntheticTrip(page);
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Journey itinerary (HTML)', exact: true }).click();
  const download = await downloadReady;
  const path = test.info().outputPath('journey-briefing.html');
  await download.saveAs(path);
  const html = await readFile(path, 'utf8');
  const escaped = (value: string) => value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] as string);
  expect(html).toContain('<!doctype html>');
  expect(html).toContain('@media print');
  expect(html).toContain('Journey briefing');
  expect(html).toContain(escaped(plan.stops[0]!.station.name));
  expect(html).toContain(`${Math.round(plan.stops[0]!.chargeKwh * 10) / 10} kWh`);
  expect(html).toContain('Synthetic data');
  if (plan.warnings.length > 0) expect(html).toContain(escaped(plan.warnings[0]!));
  expect(html).not.toContain('gradient');

  // Exercise the narrow standalone file where the single-character table regression appeared.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(pathToFileURL(path).href);
  await expect(page.locator('[data-journey-briefing]')).toBeVisible();
  await expect(page.locator('.briefing-itinerary tbody tr')).toHaveCount(plan.stops.length);
  await expect(page.locator('.briefing-itinerary tbody th .hint').first()).toHaveCSS('display', 'block');
  const screenTable = await page.evaluate(() => {
    const scroller = document.querySelector('.briefing-scroll') as HTMLElement;
    const table = document.querySelector('.briefing-itinerary') as HTMLElement;
    return {
      bodyFits: document.body.scrollWidth <= window.innerWidth,
      contained: scroller.scrollWidth > scroller.clientWidth,
      minWidth: Number.parseFloat(getComputedStyle(table).minWidth),
    };
  });
  expect(screenTable.bodyFits).toBe(true);
  expect(screenTable.contained).toBe(true);
  expect(screenTable.minWidth).toBeGreaterThanOrEqual(700);
  await expect(page.locator('.briefing-itinerary td').first()).toHaveCSS('white-space', 'nowrap');
  await expect(page.locator('.briefing-battery-value strong').first()).toHaveCSS('white-space', 'nowrap');
  await page.screenshot({ path: test.info().outputPath('journey-briefing-export.png') });
  await page.emulateMedia({ media: 'print' });
  const batteryColumns = await page.locator('.journey-battery-profile').evaluate((element) => {
    const style = getComputedStyle(element);
    return style.gridTemplateColumns.split(' ').filter(Boolean).length;
  });
  expect(batteryColumns).toBe(2);
  await expect(page.locator('.briefing-itinerary tr').first()).toHaveCSS('break-inside', 'avoid');
  await expect(page.locator('.journey-briefing h3')).toHaveCSS('break-after', 'avoid');
  await page.screenshot({
    path: test.info().outputPath('journey-briefing-export-print.png'),
    fullPage: true,
  });
});
