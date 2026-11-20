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
    await page.screenshot({
      path: test.info().outputPath(`journey-briefing-print-${viewport.width}.png`),
      fullPage: true,
    });
    await page.emulateMedia({ media: 'screen' });
  });
}

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

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(pathToFileURL(path).href);
  await expect(page.locator('[data-journey-briefing]')).toBeVisible();
  await expect(page.locator('.briefing-itinerary tbody tr')).toHaveCount(plan.stops.length);
  await page.screenshot({ path: test.info().outputPath('journey-briefing-export.png') });
});
