import { expect, test } from '@playwright/test';

const origin = { label: 'Malformed origin', lat: 28, lon: 77 };
const destination = { label: 'Malformed destination', lat: 26, lon: 75 };

function validPlan() {
  return {
    id: 'valid-retry', createdAt: '2026-01-01T00:00:00Z',
    origin, destination,
    vehicle: { label: 'EV', catalogId: null, batteryKwh: 75, claimedRangeKm: null, realWorldRangeKm: 300 },
    status: 'ok', source: 'synthetic', routeDistanceKm: 400, routeDurationMin: 400,
    geometry: [{ lat: 28, lon: 77 }, { lat: 27, lon: 76 }, { lat: 26, lon: 75 }],
    stops: [{
      station: { stationId: 42, name: 'Valid stop', brand: 'other', lat: 27, lon: 76 },
      chainageKm: 200, legKm: 202, detourKm: 2,
      arriveSocPct: 30, leaveSocPct: 80, chargeKwh: 40, pricePerKwh: 20,
      estPriceInr: 800, chargeTimeMin: 40, arrivalEtaMin: 180, departureEtaMin: 220,
    }],
    stationsSeen: 1, warnings: [],
    totals: {
      distanceKm: 400, driveTimeMin: 360, totalTimeMin: 400, chargeTimeMin: 40,
      chargeKwh: 40, estPriceInr: 800, finalSocPct: 12,
    },
  };
}

async function pickPlaces(page: import('@playwright/test').Page) {
  for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
    await page.getByRole('searchbox', { name, exact: true }).fill(query!);
    await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
  }
}

for (const mode of ['plan', 'ai'] as const) {
  test(`${mode} response with malformed stop list renders honestly and recovers on retry`, async ({ page }) => {
    await page.route(/^https?:\/\//, async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
      else await route.abort();
    });
    await page.route('**/api/health', (route) => route.fulfill({ json: { ok: true, mock: true, ai: true, chargersSeen: 0 } }));
    let call = 0;
    await page.route(mode === 'plan' ? '**/api/plan' : '**/api/ai/plan', async (route) => {
      call += 1;
      if (call === 1) {
        const broken = { ...validPlan(), stops: { unexpected: true } };
        await route.fulfill({ json: mode === 'plan' ? { plan: broken } : { plan: broken, ai: { applied: false, reason: 'Synthetic malformed payload' } } });
      } else {
        const good = { ...validPlan(), id: `valid-${call}` };
        await route.fulfill({ json: mode === 'plan' ? { plan: good } : { plan: good, ai: { applied: true, notes: 'local fixture' } } });
      }
    });
    await page.goto('/');
    await pickPlaces(page);
    const button = page.locator(mode === 'plan' ? '.planner-go' : '[data-ai-plan]');
    await button.click();
    await expect(button).toBeDisabled();
    await expect(page.locator('.plan-results')).toContainText('Charging stop list is Unknown');
    await expect(button).toBeEnabled();
    await expect(page.locator('.error-box')).toContainText('Map route unavailable');
    await button.click();
    await expect(page.locator('.stop-card')).toHaveCount(1);
    await expect(button).toBeEnabled();
    expect(call).toBe(2);
  });
}

test('malformed geometry refuses partial drawing, clears stale route and recovers', async ({ page }) => {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('**/api/health', (route) => route.fulfill({ json: { ok: true, mock: true, ai: false, chargersSeen: 0 } }));
  const variants = [
    { ...validPlan(), geometry: { lat: 28, lon: 77 } },
    { ...validPlan(), geometry: [{ lat: 28, lon: 77 }, null] },
    { ...validPlan(), stops: [null] },
    { ...validPlan(), stops: [{ station: null }] },
  ];
  let call = 0;
  await page.route('**/api/plan', async (route) => {
    const plan = call < variants.length ? variants[call]! : validPlan();
    call += 1;
    await route.fulfill({ json: { plan } });
  });
  await page.goto('/');
  await pickPlaces(page);
  const button = page.locator('.planner-go');
  await button.click();
  await expect(page.locator('.pin-origin')).toHaveCount(1);
  for (let i = 0; i < variants.length; i += 1) {
    await button.click();
    await expect(page.locator('.error-box')).toContainText('Map route unavailable');
    await expect(page.locator('.pin-origin')).toHaveCount(0);
    await expect(page.locator('.plan-results')).toContainText('Map route unavailable');
    await expect(button).toBeEnabled();
  }
  await button.click();
  await expect(page.locator('.error-box')).toBeHidden();
  await expect(page.locator('.pin-origin')).toHaveCount(1);
  await expect(page.locator('.stop-card')).toHaveCount(1);
  expect(call).toBe(variants.length + 2);
});
