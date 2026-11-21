import { expect, test } from '@playwright/test';

test('station data stays literal and non-http station URLs render no link', async ({ page }) => {
  const literalDate = '<b data-fixture="last-used">not a calendar date</b>';
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('**/api/plan', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    expect(body.plan.source).toBe('synthetic');
    expect(body.plan.stops.length).toBeGreaterThanOrEqual(2);
    body.plan.stops[0].station.stationUrl = 'data:text/plain,inert-fixture';
    for (const charger of body.plan.stops[0].station.chargers) charger.lastUsedOn = literalDate;
    body.plan.stops[1].station.stationUrl = 'https://example.com/station-fixture?source=local&detail=1';
    await route.fulfill({ response, json: body });
  });
  await page.goto('/');
  for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
    await page.getByRole('combobox', { name, exact: true }).fill(query!);
    await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
  }
  await page.getByRole('button', { name: 'Plan route', exact: true }).click();
  const first = page.locator('.stop-card').nth(0);
  const second = page.locator('.stop-card').nth(1);
  await expect(first).toContainText(literalDate);
  await expect(first.locator('[data-fixture=last-used]')).toHaveCount(0);
  await expect(first.getByRole('link', { name: 'Station page', exact: true })).toHaveCount(0);
  await expect(second.getByRole('link', { name: 'Station page', exact: true }))
    .toHaveAttribute('href', 'https://example.com/station-fixture?source=local&detail=1');
  // Links are inspected, never followed. Fixtures are inert text only.
});
