/**
 * Job lifecycle in the browser: real status polling, truthful progress,
 * cancel confirmation, failed cancel, and restart loss. Fixtures serve
 * sequential statuses over the job endpoints; no sync AI shortcut.
 */
import { expect, test, type Page } from '@playwright/test';
import { installAiJobRoutes } from './job-routes.js';

const origin = { label: 'Delhi', lat: 28.6139, lon: 77.209 };
const destination = { label: 'Jaipur', lat: 26.9124, lon: 75.7873 };

function validPlan(id = 'job-plan') {
  return {
    id, createdAt: '2026-11-21T12:00:00Z', source: 'live', status: 'ok',
    origin, destination,
    vehicle: { label: 'Harrier', catalogId: 'harrier', batteryKwh: 75, claimedRangeKm: 627, realWorldRangeKm: 300 },
    routeDistanceKm: 285, routeDurationMin: 270,
    geometry: [{ lat: 28.6, lon: 77.2 }, { lat: 26.9, lon: 75.8 }],
    warnings: [], stationsSeen: 1,
    totals: { distanceKm: 285, driveTimeMin: 270, chargeTimeMin: 20, totalTimeMin: 290,
      chargeKwh: 20, estPriceInr: null, finalSocPct: 30 },
    stops: [],
  };
}

const aiEnvelope = (id = 'job-plan') => ({
  plan: validPlan(id), ai: { applied: true, notes: 'Fixture selection.' },
});

const running = (progress: unknown = null) => ({
  jobId: 'job-1', state: 'running', startedAt: 1, finishedAt: null, progress,
});

async function wired(page: Page) {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('https://tiles.openfreemap.org/styles/dark', (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background' }] },
  }));
  await page.route('**/api/health', (route) => route.fulfill({
    json: { ok: true, mock: false, ai: true, chargersSeen: 0 },
  }));
  await page.route('**/api/vehicles', (route) => route.fulfill({
    json: { default: 'harrier', catalog: [{ id: 'harrier', make: 'Tata', model: 'Harrier',
      variantLabel: '75 kWh', batteryKwh: 75, claimedRangeKm: 627 }], note: 'fixture' },
  }));
  await page.route('**/api/geocode*', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? 'Place';
    return route.fulfill({ json: { hits: [{ name: q, label: q, lat: q === 'Delhi' ? 28.6 : 26.9,
      lon: 77.2, city: null, state: null, country: 'India' }] } });
  });
}

async function submitAi(page: Page) {
  await page.goto('/');
  for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
    await page.getByRole('combobox', { name, exact: true }).fill(query!);
    await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
  }
  await page.getByRole('button', { name: 'Plan with AI', exact: true }).click();
}

test('job progress reports unknown inventory before a known pool', async ({ page }) => {
  await wired(page);
  await installAiJobRoutes(page, () => ({ json: aiEnvelope() }), {
    statuses: (poll) => {
      if (poll === 1) return running();
      if (poll === 2) return running({
        samplesPlanned: 10, samplesCompleted: 3, samplesOk: 3, samplesFailed: 0,
        candidatesPlanned: 0, candidatesProcessed: 0, candidatesDetailed: 0,
        candidateInventoryComplete: false,
      });
      if (poll === 3) return running({
        samplesPlanned: 10, samplesCompleted: 10, samplesOk: 10, samplesFailed: 0,
        candidatesPlanned: 2, candidatesProcessed: 1, candidatesDetailed: 1,
        candidateInventoryComplete: true,
      });
      return { jobId: 'job-1', state: 'succeeded', startedAt: 1, finishedAt: 2,
        progress: null, result: aiEnvelope() };
    },
  });
  await submitAi(page);
  const progress = page.locator('.plan-busy-progress');
  await expect(progress).toContainText('inventory is not yet known');
  await expect(progress).toContainText('Charger inventory is still unknown');
  await expect(progress).toContainText('unique chargers');
  await expect(progress).not.toContainText('undefined');
  await expect(page.locator('.plan-results')).toBeVisible({ timeout: 15_000 });
});

test('cancel is claimed only after the server confirms a terminal state', async ({ page }) => {
  await wired(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await installAiJobRoutes(page, () => ({ json: aiEnvelope() }), {
    holdFirstStart: held,
    statuses: (poll) => poll === 1
      ? running()
      : { jobId: 'job-1', state: 'cancelled', startedAt: 1, finishedAt: 2, progress: null },
  });
  await submitAi(page);
  const cancel = page.locator('.plan-busy-cancel');
  await expect(cancel).toBeDisabled();
  release();
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(page.locator('.plan-busy-progress')).toContainText('confirm');
  await expect(page.locator('.error-box')).toContainText('server confirmed cancellation', { timeout: 15_000 });
  await expect(cancel).toBeEnabled();
});

test('failed cancel never claims cancellation and keeps polling', async ({ page }) => {
  await wired(page);
  await installAiJobRoutes(page, () => ({ json: aiEnvelope() }), {
    cancelShouldFail: true,
    statuses: (poll) => poll < 3
      ? running()
      : { jobId: 'job-1', state: 'succeeded', startedAt: 1, finishedAt: 2,
        progress: null, result: aiEnvelope() },
  });
  await submitAi(page);
  const cancel = page.locator('.plan-busy-cancel');
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(page.locator('.plan-busy-progress')).toContainText('could not be confirmed');
  await expect(page.locator('.error-box')).not.toContainText('server confirmed cancellation');
  await expect(page.locator('.plan-results')).toBeVisible({ timeout: 15_000 });
});

test('restart loss is reported and never auto-retried', async ({ page }) => {
  await wired(page);
  let starts = 0;
  await installAiJobRoutes(page, () => { starts += 1; return { json: aiEnvelope() }; }, {
    statuses: () => null,
  });
  await submitAi(page);
  await expect(page.locator('.error-box')).toContainText('no longer available', { timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Plan with AI', exact: true })).toBeEnabled();
  await page.waitForTimeout(2500);
  expect(starts).toBe(1);
});

test('unconfirmed run keeps the start guard closed', async ({ page }) => {
  await wired(page);
  let starts = 0;
  await installAiJobRoutes(page, () => { starts += 1; return { json: aiEnvelope() }; }, {
    statusShouldFail: true,
  });
  await submitAi(page);
  const aiButton = page.getByRole('button', { name: 'Plan with AI', exact: true });
  await expect(page.locator('.error-box')).toContainText('no confirmed terminal state', { timeout: 10_000 });
  await expect(aiButton).toBeDisabled();
  await expect(page.locator('.planner-form')).toHaveAttribute('aria-busy', 'true');
  expect(starts).toBe(1);
});
