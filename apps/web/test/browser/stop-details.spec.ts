/**
 * Tap a stop: map markers and card buttons open a stop-details sheet with
 * distances, the full charger list and an explicit live-status fetch.
 * Uses the synthetic Delhi → Jaipur plan (2 stops, 415.2 km).
 */
import { expect, test, type Page } from '@playwright/test';

async function outsideAborted(page: Page): Promise<void> {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  // A minimal local basemap so the style loads and markers are drawn.
  await page.route('https://tiles.openfreemap.org/styles/dark', (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background' }] },
  }));
}

async function planTwoStops(page: Page): Promise<void> {
  await outsideAborted(page);
  await page.route('**/api/plan', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    // Mark the first stop's charger as the one the plan selected.
    const first = body.plan.stops[0];
    first.selectedCharger = { chargerId: first.station.chargers[0].chargerId, name: first.station.chargers[0].name, kw: 60 };
    await route.fulfill({ json: body });
  });
  await page.goto('/');
  for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
    await page.getByRole('combobox', { name, exact: true }).fill(query!);
    await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
  }
  await page.locator('.planner-go').click();
  await expect(page.locator('.stop-card')).toHaveCount(2);
}

test('stop cards show leg distances, a final leg and the charger list', async ({ page }) => {
  await planTwoStops(page);
  const legs = page.locator('.stop-card [data-stop-leg]');
  await expect(legs.nth(0)).toHaveText(/^198 km from Delhi/);
  await expect(legs.nth(1)).toHaveText(/^207 km from Statiq Highway Plaza/);
  const connectors = page.locator('.plan-results .leg-connector');
  await expect(connectors).toHaveCount(2);
  await expect(connectors.nth(0)).toContainText('207 km to Tata Power Charge Zone');
  // 415.2 - 405 + 1.1 = 11.3 km, same math as the journey briefing
  await expect(connectors.nth(1)).toContainText('Final leg · 11.3 km to Jaipur');
  const firstList = page.locator('.stop-card').first().locator('.charger-list .charger-row');
  await expect(firstList).toHaveCount(1);
  await expect(firstList.first()).toHaveClass(/is-selected/);
  await expect(firstList.first()).toContainText('Used for this plan');
  await expect(firstList.first()).toContainText('1 free · 1 occupied');
});

test('tapping a map stop opens its charger details; next/prev, escape and focus work', async ({ page }) => {
  await planTwoStops(page);
  const marker = page.getByRole('button', { name: /Charging stop 2: Tata Power Charge Zone .* show charger details/ });
  await expect(marker).toBeVisible();
  await marker.click();
  const sheet = page.getByRole('dialog', { name: 'Tata Power Charge Zone' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Stop 2 of 2');
  await expect(sheet).toContainText('From Statiq Highway Plaza');
  await expect(sheet).toContainText('To Jaipur');
  await expect(sheet.locator('.charger-row')).toHaveCount(1);
  await expect(sheet.locator('.charger-plug')).not.toHaveCount(0);
  await expect(page.locator('.stop-marker.is-active')).toHaveCount(1);
  await expect(page.locator('.stop-card.is-active')).toHaveCount(1);

  await sheet.getByRole('button', { name: 'Previous stop' }).click();
  await expect(page.getByRole('dialog', { name: 'Statiq Highway Plaza' })).toContainText('Stop 1 of 2');
  await expect(page.getByRole('button', { name: 'Previous stop' })).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('dialog', { name: 'Tata Power Charge Zone' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.stop-sheet')).toBeHidden();
  await expect(page.locator('.stop-marker.is-active')).toHaveCount(0);
  await expect(marker).toBeFocused();
});

test('keyboard Enter on a marker and the card button both open the sheet', async ({ page }) => {
  await planTwoStops(page);
  const marker = page.getByRole('button', { name: /Charging stop 1: Statiq Highway Plaza/ });
  await marker.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Statiq Highway Plaza' })).toBeVisible();
  await page.getByRole('button', { name: 'Close charger details' }).click();
  await expect(page.locator('.stop-sheet')).toBeHidden();

  const cardButton = page.locator('.stop-card').nth(1).getByRole('button', { name: 'Charger details' });
  await cardButton.click();
  await expect(page.getByRole('dialog', { name: 'Tata Power Charge Zone' })).toBeVisible();
  await page.getByRole('button', { name: 'Close charger details' }).click();
  await expect(cardButton).toBeFocused();
});

test('live status is fetched only on an explicit click, once per click', async ({ page }) => {
  let calls = 0;
  await planTwoStops(page);
  // Registered after the catch-all so it wins (newest route matches first).
  await page.route('**/api/stations/*', async (route) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({ json: { station: {
      stationId: 9101, name: 'Statiq Highway Plaza', address: 'NH 48', city: 'Behror',
      hours: '24 hours', openText: 'Open Now', rating: 4.3, reviewCount: 10, reliability: null,
      fetchedAt: '2026-11-22T10:15:00.000Z', synthetic: false,
      chargers: [{ chargerId: 91010, name: 'Live DC', type: 'DC', kw: 60, pricePerKwh: 22, lastUsedOn: null,
        connectors: [{ connectorId: 1, type: 'CCS-2', status: 'available', available: true, note: null }] }],
    } } });
  });
  await page.getByRole('button', { name: /Charging stop 1: Statiq Highway Plaza/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Statiq Highway Plaza' });
  await expect(sheet).toBeVisible();
  expect(calls).toBe(0);
  const fetchButton = sheet.getByRole('button', { name: 'Fetch live status' });
  // Two synchronous clicks in one task: the in-flight guard must collapse them.
  await fetchButton.evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(fetchButton).toBeDisabled();
  await expect(sheet.locator('[data-ss-live-status]')).toContainText('Snapshot fetched');
  await expect(sheet.locator('[data-ss-live-result]')).toContainText('Live DC');
  expect(calls).toBe(1);
  await fetchButton.click();
  await expect.poll(() => calls).toBe(2);
});

test('a new plan closes an open sheet', async ({ page }) => {
  await planTwoStops(page);
  await page.getByRole('button', { name: /Charging stop 1: Statiq Highway Plaza/ }).click();
  await expect(page.locator('.stop-sheet')).toBeVisible();
  await page.locator('.planner-go').click();
  await expect(page.locator('.stop-sheet')).toBeHidden();
});
