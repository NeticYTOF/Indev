import { expect, test } from '@playwright/test';

const SAVED_ORIGIN = { label: 'Delhi — saved exact', lat: 28.6139, lon: 77.209 };
const SAVED_DESTINATION = { label: 'Jaipur — saved exact', lat: 26.9124, lon: 75.7873 };
const CATALOG = [
  {
    id: 'tata-harrier-ev-75', make: 'Tata', model: 'Harrier EV',
    variantLabel: '75 kWh', batteryKwh: 75, claimedRangeKm: 627,
  },
  {
    id: 'nondefault-exact', make: 'Example', model: 'Exact Pack',
    variantLabel: '75.01 kWh', batteryKwh: 75.01, claimedRangeKm: 640,
  },
];

interface PlanBody {
  origin: { label: string; lat: number; lon: number };
  destination: { label: string; lat: number; lon: number };
  startSocPct?: number;
  vehicle?: {
    entryId?: string;
    custom?: { batteryKwh: number; realWorldRangeKm: number };
    realWorldRangeKm?: number;
  };
}

interface Counters {
  geocode: number;
  plan: number;
  ai: number;
  station: number;
  save: number;
  lastPlanBody?: PlanBody;
  lastAiBody?: PlanBody;
}

function savedTrip(batteryKwh: number | null = 75, catalogId: string | null = 'tata-harrier-ev-75') {
  return {
    id: 'edit-fixture', name: 'Saved editable route', createdAt: '2026-11-20T10:00:00Z',
    source: 'synthetic', status: 'ok',
    origin: SAVED_ORIGIN, destination: SAVED_DESTINATION,
    routeDistanceKm: 285, routeDurationMin: 270,
    geometry: [[28.6139, 77.209], [26.9124, 75.7873]],
    vehicle: {
      label: 'Saved Harrier — label must survive fallback', catalogId,
      batteryKwh, claimedRangeKm: 627, realWorldRangeKm: 300,
    },
    totals: {
      distanceKm: 285, driveTimeMin: 270, chargeTimeMin: 0, totalTimeMin: 270,
      chargeKwh: 0, estPriceInr: null, finalSocPct: 40,
    },
    stations: [],
  };
}

function syntheticPlan(requestBody: {
  origin: { label: string; lat: number; lon: number };
  destination: { label: string; lat: number; lon: number };
}) {
  return {
    id: 'new-plan', createdAt: '2026-11-20T12:00:00Z',
    origin: requestBody.origin, destination: requestBody.destination,
    vehicle: {
      label: 'Tata Harrier EV (75 kWh)', catalogId: 'tata-harrier-ev-75',
      batteryKwh: 75, claimedRangeKm: 627, realWorldRangeKm: 300,
    },
    status: 'ok', source: 'synthetic',
    routeDistanceKm: 285, routeDurationMin: 270,
    geometry: [[28.6139, 77.209], [26.9124, 75.7873]],
    stops: [], stationsSeen: 0, warnings: [],
    totals: {
      distanceKm: 285, driveTimeMin: 270, chargeTimeMin: 0, totalTimeMin: 270,
      chargeKwh: 0, estPriceInr: null, finalSocPct: 40,
    },
  };
}

async function wiredPage(
  page: import('@playwright/test').Page,
  counters: Counters,
  options: {
    holdVehicles?: Promise<void>;
    holdPlan?: Promise<void>;
    batteryKwh?: number | null;
    catalogId?: string | null;
    geocodeHits?: Array<{ label: string; lat: number; lon: number }>;
  } = {},
): Promise<void> {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('**/api/health', (route) => route.fulfill({
    json: { ok: true, mock: true, ai: true, chargersSeen: 0 },
  }));
  await page.route('**/api/vehicles', async (route) => {
    if (options.holdVehicles) await options.holdVehicles;
    return route.fulfill({
      json: { default: 'tata-harrier-ev-75', catalog: CATALOG, note: 'Synthetic catalog fixture' },
    });
  });
  await page.route('**/api/trips', async (route) => {
    if (route.request().method() === 'POST') counters.save++;
    return route.fulfill({ json: { trips: [savedTrip(options.batteryKwh, options.catalogId)] } });
  });
  await page.route('**/api/trips/*', (route) => route.fulfill({ json: { ok: true } }));
  await page.route('**/api/geocode*', (route) => {
    counters.geocode++;
    const hits = (options.geocodeHits ?? []).map((hit) => ({
      ...hit, name: hit.label, city: null, state: null, country: null,
    }));
    return hits.length > 0 ? route.fulfill({ json: { hits } }) : route.abort();
  });
  await page.route('**/api/stations/*', (route) => { counters.station++; return route.abort(); });
  await page.route('**/api/ai/plan', async (route) => {
    counters.ai++;
    const body = route.request().postDataJSON() as PlanBody;
    counters.lastAiBody = body;
    return route.fulfill({ json: { plan: syntheticPlan(body), ai: { applied: false, reason: 'fixture' } } });
  });
  await page.route('**/api/plan', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    counters.plan++;
    const body = route.request().postDataJSON() as PlanBody;
    counters.lastPlanBody = body;
    if (options.holdPlan) await options.holdPlan;
    return route.fulfill({ json: { plan: syntheticPlan(body) } });
  });
  await page.goto('/');
}

test('editing from the drawer copies facts only, with mobile focus and no requests', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const counters: Counters = { geocode: 0, plan: 0, ai: 0, station: 0, save: 0 };
  await wiredPage(page, counters);
  await page.locator('#trips-button').click();
  await page.getByRole('button', { name: 'Edit route', exact: true }).click();

  await expect(page.locator('.saved-route-review')).toContainText('Editing saved route');
  await expect(page.locator('.saved-route-review')).toContainText('Start charge, charging reserve and other plan options were not stored');
  await expect(page.locator('.saved-route-review')).toContainText('default catalog entry');
  await expect(page.locator('.saved-route-review')).toContainText('Saved Harrier — label must survive fallback');
  await expect(page.getByRole('searchbox', { name: 'From', exact: true })).toHaveValue(SAVED_ORIGIN.label);
  await expect(page.getByRole('searchbox', { name: 'To', exact: true })).toHaveValue(SAVED_DESTINATION.label);
  await expect(page.locator('select[data-vehicle]')).toHaveValue('custom');
  await expect(page.locator('input[data-custom-kwh]')).toHaveValue('75');
  await expect(page.locator('input[data-real-world]')).toHaveValue('300');
  await expect(page.locator('.plan-results')).toHaveCount(0);
  await expect(page.locator('#planner-panel')).toHaveClass(/open/);
  await expect(page.locator('#sheet-open')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('searchbox', { name: 'From', exact: true })).toBeFocused();
  expect(counters).toEqual({ geocode: 0, plan: 0, ai: 0, station: 0, save: 0 });
  await page.screenshot({ path: info.outputPath('saved-route-edit-mobile.png') });
});

test('editing from the saved summary uses the same manual-only flow', async ({ page }, info) => {
  const counters: Counters = { geocode: 0, plan: 0, ai: 0, station: 0, save: 0 };
  await wiredPage(page, counters);
  await page.locator('#trips-button').click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('[data-journey-briefing]')).toBeVisible();

  await page.locator('.saved-briefing-actions [data-edit-saved]').click();
  await expect(page.locator('.saved-route-review')).toContainText('Editing saved route');
  await expect(page.getByRole('searchbox', { name: 'From', exact: true })).toHaveValue(SAVED_ORIGIN.label);
  await expect(page.getByRole('searchbox', { name: 'To', exact: true })).toHaveValue(SAVED_DESTINATION.label);
  await expect(page.locator('.plan-results')).toHaveCount(0);
  expect(counters).toEqual({ geocode: 0, plan: 0, ai: 0, station: 0, save: 0 });
  await page.screenshot({ path: info.outputPath('saved-route-summary-edit.png') });
});

test('manual replan waits for deferred catalog and preserves saved coordinates', async ({ page }, info) => {
  let releaseVehicles!: () => void;
  const vehicles = new Promise<void>((resolve) => { releaseVehicles = resolve; });
  const counters: Counters = { geocode: 0, plan: 0, ai: 0, station: 0, save: 0 };
  await wiredPage(page, counters, { holdVehicles: vehicles });
  await page.locator('#trips-button').click();
  await page.getByRole('button', { name: 'Edit route', exact: true }).click();

  await page.getByRole('button', { name: 'Plan route', exact: true }).click();
  await expect(page.locator('.error-box')).toContainText('Waiting for the saved vehicle selection');
  expect(counters.plan).toBe(0);
  expect(counters.ai).toBe(0);
  releaseVehicles();
  await expect(page.locator('input[data-custom-kwh]')).toHaveValue('75');
  await expect(page.locator('input[data-real-world]')).toHaveValue('300');
  await page.getByRole('button', { name: 'Decrease charge', exact: true }).click();
  await page.getByRole('button', { name: 'Plan route', exact: true }).click();
  await expect(page.locator('.plan-results')).toBeVisible();
  expect(counters.plan).toBe(1);
  expect(counters.geocode).toBe(0);
  expect(counters.lastPlanBody).toMatchObject({
    origin: SAVED_ORIGIN,
    destination: SAVED_DESTINATION,
    startSocPct: 95,
    vehicle: { custom: { batteryKwh: 75, realWorldRangeKm: 300 } },
  });
  expect(counters.save).toBe(0);
  await page.screenshot({ path: info.outputPath('saved-route-manual-replan.png') });
});

test('AI replan is refused while a deferred saved catalog is still loading', async ({ page }) => {
  let releaseVehicles!: () => void;
  const vehicles = new Promise<void>((resolve) => { releaseVehicles = resolve; });
  const counters: Counters = { geocode: 0, plan: 0, ai: 0, station: 0, save: 0 };
  await wiredPage(page, counters, { holdVehicles: vehicles });
  await page.locator('#trips-button').click();
  await page.getByRole('button', { name: 'Edit route', exact: true }).click();

  await page.getByRole('button', { name: 'Plan with AI', exact: true }).click();
  await expect(page.locator('.error-box')).toContainText('Waiting for the saved vehicle selection');
  expect(counters.ai).toBe(0);
  expect(counters.plan).toBe(0);
  releaseVehicles();
  await expect(page.locator('input[data-custom-kwh]')).toHaveValue('75');
  await page.getByRole('button', { name: 'Plan with AI', exact: true }).click();
  await expect(page.locator('.plan-results')).toBeVisible();
  expect(counters.ai).toBe(1);
});

test('stale saved battery stays in custom inputs with a visible reason', async ({ page }) => {
  const counters: Counters = { geocode: 0, plan: 0, ai: 0, station: 0, save: 0 };
  await wiredPage(page, counters, { batteryKwh: 62, catalogId: 'tata-harrier-ev-75' });
  await page.locator('#trips-button').click();
  await page.getByRole('button', { name: 'Edit route', exact: true }).click();
  await expect(page.locator('select[data-vehicle]')).toHaveValue('custom');
  await expect(page.locator('input[data-custom-kwh]')).toHaveValue('62');
  await expect(page.locator('.saved-route-review')).toContainText('saved battery does not match');
  await expect(page.locator('.saved-route-review')).toContainText('Saved Harrier — label must survive fallback');
  expect(counters.plan).toBe(0);
});

test('a fractional battery mismatch never maps to a catalog entry', async ({ page }) => {
  const counters: Counters = { geocode: 0, plan: 0, ai: 0, station: 0, save: 0 };
  await wiredPage(page, counters, { batteryKwh: 75, catalogId: 'nondefault-exact' });
  await page.locator('#trips-button').click();
  await page.getByRole('button', { name: 'Edit route', exact: true }).click();
  await expect(page.locator('select[data-vehicle]')).toHaveValue('custom');
  await expect(page.locator('input[data-custom-kwh]')).toHaveValue('75');
  await expect(page.locator('.saved-route-review')).toContainText('saved battery does not match');
  expect(counters.plan).toBe(0);
});

test('an exactly matching non-default catalog entry restores its range', async ({ page }) => {
  const counters: Counters = { geocode: 0, plan: 0, ai: 0, station: 0, save: 0 };
  await wiredPage(page, counters, { batteryKwh: 75.01, catalogId: 'nondefault-exact' });
  await page.locator('#trips-button').click();
  await page.getByRole('button', { name: 'Edit route', exact: true }).click();
  await expect(page.locator('select[data-vehicle]')).toHaveValue('nondefault-exact');
  await expect(page.locator('input[data-real-world]')).toHaveValue('300');
  await expect(page.locator('.saved-route-review')).not.toContainText('custom inputs');
  expect(counters.plan).toBe(0);
});

test('a missing saved battery stays blank and requires user input', async ({ page }) => {
  const counters: Counters = { geocode: 0, plan: 0, ai: 0, station: 0, save: 0 };
  await wiredPage(page, counters, { batteryKwh: null, catalogId: 'tata-harrier-ev-75' });
  await page.locator('#trips-button').click();
  await page.getByRole('button', { name: 'Edit route', exact: true }).click();
  await expect(page.locator('select[data-vehicle]')).toHaveValue('custom');
  await expect(page.locator('input[data-custom-kwh]')).toHaveValue('');
  await expect(page.locator('input[data-real-world]')).toHaveValue('300');
  await expect(page.locator('.saved-route-review')).toContainText('Saved battery size was missing');
  await expect(page.locator('.saved-route-review')).toContainText('saved battery does not match');
  expect(counters.plan).toBe(0);
});

test('typing invalidates restored coordinates and late geocode results', async ({ page }) => {
  const counters: Counters = { geocode: 0, plan: 0, ai: 0, station: 0, save: 0 };
  await wiredPage(page, counters, {
    geocodeHits: [{ label: 'Late geocoded Delhi', lat: 19.076, lon: 72.8777 }],
  });
  await page.locator('#trips-button').click();
  await page.getByRole('button', { name: 'Edit route', exact: true }).click();
  const origin = page.getByRole('searchbox', { name: 'From', exact: true });
  await origin.fill('Late geocoded Delhi');
  await expect(page.locator('.suggestions:not(.hidden) .suggestion-item')).toContainText('Late geocoded Delhi');
  await expect(origin).toHaveValue('Late geocoded Delhi');
  await expect(origin).not.toHaveValue(SAVED_ORIGIN.label);
  await page.getByRole('button', { name: 'Plan route', exact: true }).click();
  await expect(page.locator('.error-box')).toContainText('Pick both a starting point');
  expect(counters.geocode).toBeGreaterThan(0);
  expect(counters.plan).toBe(0);
  expect(counters.ai).toBe(0);
  expect(counters.save).toBe(0);
});

test('editing is refused while a plan is in flight', async ({ page }) => {
  let releasePlan!: () => void;
  const plan = new Promise<void>((resolve) => { releasePlan = resolve; });
  const counters: Counters = { geocode: 0, plan: 0, ai: 0, station: 0, save: 0 };
  await wiredPage(page, counters, { holdPlan: plan });
  await page.locator('#trips-button').click();
  await page.getByRole('button', { name: 'Edit route', exact: true }).click();
  await page.getByRole('button', { name: 'Plan route', exact: true }).click();

  await page.locator('#trips-button').click();
  await page.getByRole('button', { name: 'Edit route', exact: true }).click();
  await expect(page.locator('.error-box')).toContainText('A plan is already running');
  expect(counters.plan).toBe(1);
  releasePlan();
  await expect(page.locator('.plan-results')).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'From', exact: true })).toHaveValue(SAVED_ORIGIN.label);
});

test('AI replan after editing is manual and uses the saved exact coordinates', async ({ page }) => {
  const counters: Counters = { geocode: 0, plan: 0, ai: 0, station: 0, save: 0 };
  await wiredPage(page, counters);
  await page.locator('#trips-button').click();
  await page.getByRole('button', { name: 'Edit route', exact: true }).click();

  await page.getByRole('button', { name: 'Plan with AI', exact: true }).click();
  await expect(page.locator('.plan-results')).toBeVisible();
  expect(counters.ai).toBe(1);
  expect(counters.plan).toBe(0);
  expect(counters.geocode).toBe(0);
  expect(counters.lastAiBody).toMatchObject({ origin: SAVED_ORIGIN, destination: SAVED_DESTINATION });
  expect(counters.save).toBe(0);
});
