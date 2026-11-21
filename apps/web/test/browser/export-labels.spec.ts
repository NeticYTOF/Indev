import { expect, test } from '@playwright/test';
import { pathToFileURL } from 'node:url';

test('export keeps both long endpoints and vehicle provenance within its card', async ({ page }) => {
  const origin = 'Indira Gandhi International Airport, New Delhi, Delhi, India';
  const destination = 'Chhatrapati Shivaji Maharaj International Airport, Mumbai, Maharashtra, India';
  await page.route(/^https?:\/\//, async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('**/api/plan', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.plan.origin.label = origin;
    body.plan.destination.label = destination;
    body.plan.vehicle.label = 'Tata Harrier EV 75 kWh ' + 'Long vehicle label '.repeat(12);
    await route.fulfill({ json: body });
  });
  await page.goto('/');
  for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
    await page.getByRole('combobox', { name, exact: true }).fill(query!);
    await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
  }
  await page.locator('.planner-go').click();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Animated export', exact: true }).click();
  const download = await downloadReady;
  const path = test.info().outputPath('long-labels.svg');
  await download.saveAs(path);
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.goto(pathToFileURL(path).href);
  await expect(page.locator('svg > title')).toHaveText(`${origin} → ${destination}`);
  const header = page.locator('svg > text').first();
  await expect(header.locator('title')).toHaveText(`${origin} → ${destination}`);
  const visible = await header.evaluate(el => Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(''));
  expect(visible).toContain('Indira Gandhi');
  expect(visible).toContain('Chhatrapati Shivaji');
  expect(visible).toContain('… → ');
  expect(await page.locator('svg > text').nth(1).evaluate(el => Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(''))).toContain('SYNTHETIC DATA (MOCK)');
  const bounds = await page.locator('svg > text').evaluateAll(nodes => nodes.slice(0, 2).map(n => {
    const b = (n as SVGGraphicsElement).getBBox();
    return { x: b.x, right: b.x + b.width };
  }));
  for (const b of bounds) {
    expect(b.x).toBeGreaterThanOrEqual(69);
    expect(b.right).toBeLessThanOrEqual(1131);
  }
  // Freeze at the finished animation state for deterministic visual review.
  await page.evaluate(() => {
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = '.fade { opacity: 1 !important; animation: none !important; } .draw { stroke-dashoffset: 0 !important; animation: none !important; }';
    document.documentElement.appendChild(style);
  });
  await page.screenshot({ path: test.info().outputPath('long-labels.png') });
});
