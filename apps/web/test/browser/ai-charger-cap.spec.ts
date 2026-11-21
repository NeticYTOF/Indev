import { expect, test, type Page } from '@playwright/test';

interface Body {
  maxChargerKw?: number;
}
interface Counters {
  ai: number;
  lastAiBody?: Body;
}
function plan(body: { origin: { label: string }; destination: { label: string } }) {
  return {
    id: 'capped-plan', createdAt: '2026-11-21T12:00:00Z', source: 'live', status: 'ok',
    origin: { label: body.origin.label, lat: 28.6, lon: 77.2 },
    destination: { label: body.destination.label, lat: 26.9, lon: 75.8 },
    vehicle: { label: 'Fixture EV', catalogId: null, batteryKwh: 75, claimedRangeKm: null, realWorldRangeKm: 300 },
    routeDistanceKm: 285, routeDurationMin: 270,
    geometry: [{ lat: 28.6, lon: 77.2 }, { lat: 26.9, lon: 75.8 }],
    warnings: ['Skipping "180 kW site" (7201): no usable charger is rated at or below the configured kW cap.'],
    stationsSeen: 2,
    totals: { distanceKm: 285, driveTimeMin: 270, chargeTimeMin: 20, totalTimeMin: 290,
      chargeKwh: 20, estPriceInr: null, finalSocPct: 30 },
    stops: [{
      station: { stationId: 7201, name: 'Mixed power site', brand: 'statiq', lat: 28, lon: 77,
        address: null, city: null, hours: null, openText: null, rating: null, reviewCount: null,
        reliability: null, fetchedAt: '2026-11-21T12:00:00Z', amenities: [], stationUrl: null,
        navUrl: null,
        chargers: [{ chargerId: 7220, name: '60 kW charger', type: 'DC', kw: 60,
          pricePerKwh: null, lastUsedOn: null, plugs: [] }] },
      chainageKm: 120, legKm: 120, detourKm: 0, arriveSocPct: 25, leaveSocPct: 50,
      chargeKwh: 20, pricePerKwh: null, estPriceInr: null, chargeTimeMin: 20,
      arrivalEtaMin: 110, departureEtaMin: 130,
      selectedCharger: { chargerId: 7220, name: '60 kW charger', kw: 60, pricePerKwh: null },
    }],
  };
}
async function wiredPage(page: Page, counters: Counters): Promise<void> {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('**/api/health', (route) => route.fulfill({
    json: { ok: true, mock: false, ai: true, chargersSeen: 0 },
  }));
  await page.route('**/api/vehicles', (route) => route.fulfill({
    json: { default: 'harrier', catalog: [{ id: 'harrier', make: 'Tata', model: 'Harrier',
      variantLabel: '75 kWh', batteryKwh: 75, claimedRangeKm: 627 }], note: 'fixture' },
  }));
  await page.route('**/api/geocode*', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? 'Place';
    return route.fulfill({ json: { hits: [{ name: q, label: q, lat: 28.6, lon: 77.2,
      city: null, state: null, country: 'India' }] } });
  });
  await page.route('**/api/ai/plan', (route) => {
    counters.ai += 1;
    counters.lastAiBody = route.request().postDataJSON() as Body;
    return route.fulfill({ json: { plan: plan({
      origin: (counters.lastAiBody as unknown as { origin: { label: string } }).origin,
      destination: (counters.lastAiBody as unknown as { destination: { label: string } }).destination,
    }), ai: { applied: true, notes: 'Fixture selection.' } } });
  });
}
async function pick(page: Page, name: string, value: string): Promise<void> {
  await page.getByRole('combobox', { name, exact: true }).fill(value);
  await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
}
test('AI charger cap propagates, rejects invalid locally, and blank omits it', async ({ page }, info) => {
  const counters: Counters = { ai: 0 };
  await wiredPage(page, counters);
  await page.goto('/');
  await pick(page, 'From', 'Delhi');
  await pick(page, 'To', 'Jaipur');
  const cap = page.locator('#ai-max-charger-kw');
  await expect(cap).toBeVisible();
  await cap.fill('0');
  await page.getByRole('button', { name: 'Plan with AI', exact: true }).click();
  await expect(page.locator('.error-box')).toContainText('Maximum charger power must be a positive number');
  expect(counters.ai).toBe(0);
  await cap.fill('100');
  await cap.blur();
  await expect(page.locator('input[data-custom-kwh]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Plan with AI', exact: true }).click();
  await expect(page.locator('.plan-results')).toBeVisible();
  expect(counters.lastAiBody).toMatchObject({ maxChargerKw: 100 });
  await expect(page.locator('.stop-stats')).toContainText('Selected charger 60 kW charger (#7220)');
  await expect(page.locator('.stop-stats')).toContainText('Tariff unknown');
  const capWarn = page.locator('.plan-results > .banners > .banner-warn',
    { hasText: 'rated at or below the configured kW cap' });
  await expect(capWarn).toHaveCount(1);
  await expect(capWarn).toContainText('rated at or below the configured kW cap');
  await expect(cap).toHaveValue('100');
  await cap.fill('');
  await page.getByRole('button', { name: 'Plan with AI', exact: true }).click();
  await expect.poll(() => counters.ai).toBe(2);
  expect(counters.lastAiBody).not.toHaveProperty('maxChargerKw');
  await page.screenshot({ path: info.outputPath('ai-charger-cap.png') });
});
