import { expect, test } from '@playwright/test';

const ORIGIN = { label: 'Delhi', lat: 28.6139, lon: 77.209 };
const DESTINATION = { label: 'Jaipur', lat: 26.9124, lon: 75.7873 };
const STATION_ID = 9101;

async function outsideAborted(page: import('@playwright/test').Page): Promise<void> {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
}

async function planFresh(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
    await page.getByRole('searchbox', { name, exact: true }).fill(query!);
    await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
  }
  await page.getByRole('button', { name: 'Plan route', exact: true }).click();
  await expect(page.locator('[data-journey-briefing]')).toBeVisible();
}

function normalStation(stationId: number, synthetic = false) {
  return {
    stationId, name: 'Detailed corridor stop', address: 'NH 48', city: 'Kotputli',
    hours: '00:00 To 23:59', openText: 'Open Now', rating: 4.3, reviewCount: 128,
    reliability: null, fetchedAt: '2026-11-20T10:15:00.000Z', synthetic,
    ccs2: {
      total: 2, usable: 1, free: 1, occupied: 0, uncertain: 0, faulted: 1,
      offline: 0, maxKw: 60, pricePerKwh: 22.75, hasContradiction: false, isUsable: true,
    },
    chargers: [{
      chargerId: 700, name: 'DC fast charger', type: 'DC', kw: 60,
      pricePerKwh: 22.75, lastUsedOn: '18/11/2026',
      connectors: [
        { connectorId: 1, type: 'CCS-2', status: 'available', available: true, note: null },
      ],
    }, {
      chargerId: 701, name: 'Faulty sibling', type: 'DC', kw: 50,
      pricePerKwh: null, lastUsedOn: null,
      connectors: [
        { connectorId: 2, type: 'CCS-2', status: 'faulted', available: false, note: 'Faulted' },
      ],
    }],
  };
}

async function stationResponse(page: import('@playwright/test').Page, handler: (route: import('@playwright/test').Route) => Promise<void> | void) {
  await page.route('**/api/stations/*', handler);
}

test('fresh plan opens one detailed evidence workspace only after explicit fetch', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await outsideAborted(page);
  let fetches = 0;
  let requestedId = 0;
  await stationResponse(page, async (route) => {
    fetches++;
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    requestedId = id;
    await route.fulfill({ json: { station: normalStation(id) } });
  });
  await planFresh(page);

  const card = page.locator('.stop-card').first();
  const details = card.locator('[data-station-evidence]');
  await expect(details).toHaveCount(1);
  await expect(details).not.toHaveAttribute('open', '');
  await expect(details.locator('[data-station-evidence-status]')).toContainText('No current status requested');
  expect(fetches).toBe(0);

  await details.locator('summary').click();
  expect(fetches).toBe(0);
  await expect(details.locator('[data-station-evidence-status]')).toContainText('No current status requested');

  await card.getByRole('button', { name: 'Revalidate', exact: true }).click();
  await expect.poll(() => fetches).toBe(1);
  await expect(details.locator('[data-station-evidence-status]')).toContainText('Station details received');
  await expect(details.locator('[data-station-evidence-result]')).toHaveAttribute('data-evidence-station-id', String(requestedId));
  await expect(details.locator('[data-station-evidence-result]')).toContainText('Rs. 22.75/kWh');
  await expect(details.locator('[data-station-evidence-result]')).toContainText('Working · free');
  await expect(details.locator('[data-station-evidence-result]')).toContainText('Faulted');
  await expect(details.locator('[data-station-evidence-result]')).toContainText('1 usable');
  await expect(details.locator('[data-station-evidence-result]')).toContainText('1 free');
  await expect(details.locator('[data-station-evidence-result]')).toContainText('18/11/2026');
  expect(fetches).toBe(1);
  await details.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('station-evidence-fresh-normal.png') });
});

test('malformed and sparse station facts stay Unknown beside unchanged planned facts', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await outsideAborted(page);
  await page.route('**/api/plan', async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { plan: {
      stops: Array<{ station: Record<string, unknown>; pricePerKwh: number; chargeKwh: number; chargeTimeMin: number }>;
    } };
    const stop = body.plan.stops[0];
    if (stop) {
      stop.station.rating = '<img src=x onerror=malformed>';
      stop.station.reviewCount = 1.5;
      stop.station.chargers = [];
    }
    await route.fulfill({ response, json: body });
  });
  await stationResponse(page, async (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    await route.fulfill({ json: { station: {
      stationId: id, name: 'Sparse malformed stop', rating: 3, reviewCount: 7,
      fetchedAt: 'not-a-date', chargers: [{ chargerId: 1, name: 'DC', type: 'DC', kw: -1, pricePerKwh: 'free',
        connectors: [{ connectorId: 1, type: 'CCS-2', status: 'available', available: 'yes', note: null, health: 'working-free' }] }],
      ccs2: { total: 2.5, usable: 0, free: 0, occupied: 0, uncertain: 0, faulted: 0, maxKw: -5, pricePerKwh: 'x' },
    } } });
  });
  await planFresh(page);
  const details = page.locator('.stop-card').first().locator('[data-station-evidence]');
  await details.locator('summary').click();
  await expect(details.locator('.evidence-station')).toContainText('No charger connectors were returned in this planned snapshot');
  await page.getByRole('button', { name: 'Revalidate', exact: true }).first().click();
  const result = details.locator('[data-station-evidence-result]');
  await expect(result).toContainText('3 · 7 reviews');
  await expect(result).toContainText('Uncertain');
  await expect(result).toContainText('Unknown kW');
  await expect(details.locator('[data-station-evidence-status]')).toContainText('snapshot time is not verified');
  await expect(result.locator('[data-malformed-proof]')).toHaveCount(0);
  await expect(page.locator('img[onerror=malformed]')).toHaveCount(0);
  await details.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('station-evidence-malformed-mobile.png') });
});

test('synthetic manual evidence stays visibly labelled as a fixture', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await outsideAborted(page);
  await stationResponse(page, async (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    await route.fulfill({ json: { station: normalStation(id, true) } });
  });
  await planFresh(page);
  const details = page.locator('.stop-card').first().locator('[data-station-evidence]');
  await page.getByRole('button', { name: 'Revalidate', exact: true }).first().click();
  const result = details.locator('[data-station-evidence-result]');
  await expect(result).toContainText('Synthetic station — fixed sample, not live charger data.');
  await expect(details.locator('[data-station-evidence-status]')).toContainText('Charger availability is a snapshot, not guaranteed live.');
  await details.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('station-evidence-synthetic-mobile.png') });
});

test('saved trip shows stored facts separately from its one manual evidence fetch', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await outsideAborted(page);
  let fetches = 0;
  await page.route('**/api/trips', (route) => route.fulfill({ json: { trips: [{
    id: 'evidence-fixture', name: 'Evidence fixture', createdAt: '2026-11-20T10:00:00Z',
    source: 'synthetic', status: 'ok', origin: ORIGIN, destination: DESTINATION,
    routeDistanceKm: 285, routeDurationMin: 270,
    geometry: [[ORIGIN.lat, ORIGIN.lon], [DESTINATION.lat, DESTINATION.lon]],
    vehicle: {
      label: 'Harrier', catalogId: null, batteryKwh: 75,
      claimedRangeKm: 627, realWorldRangeKm: 300,
    },
    totals: {
      distanceKm: 285, driveTimeMin: 270, chargeTimeMin: 42, totalTimeMin: 312,
      chargeKwh: 42.7, estPriceInr: 854, finalSocPct: 12,
    },
    stations: [{
      stationId: STATION_ID, name: 'Saved evidence stop', lat: 27.5, lon: 76.5,
      chainageKm: 160, legKm: 162, detourKm: 2,
      arriveSocPct: 20, leaveSocPct: 80, chargeKwh: 42.7,
      pricePerKwh: 22.75, estPriceInr: 854, chargeTimeMin: 42,
    }],
  }] } }));
  await stationResponse(page, async (route) => {
    fetches++;
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    await route.fulfill({ json: { station: normalStation(id) } });
  });

  await page.goto('/');
  await page.locator('#trips-button').click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  const details = page.locator('.saved-stop').first().locator('[data-station-evidence]');
  await details.locator('summary').click();
  await expect(details).toContainText('Planned snapshot from the trip');
  await expect(details).toContainText('Rs. 22.75/kWh');
  await expect(details).toContainText('42.7 kWh');
  await expect(details).toContainText('This saved trip stores planned charging facts, not a charger snapshot');
  await expect(details.locator('[data-station-evidence-result]')).toHaveCount(0);
  expect(fetches).toBe(0);

  await page.getByRole('button', { name: 'Fetch current details', exact: true }).click();
  await expect.poll(() => fetches).toBe(1);
  await expect(details.locator('[data-station-evidence-status]')).toContainText('Station details received');
  await expect(details.locator('[data-station-evidence-result]')).toContainText('Working · free');
  expect(fetches).toBe(1);
  await details.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('station-evidence-saved-mobile.png') });
});

test('a wrong station ID in the response is refused and never rendered', async ({ page }) => {
  await outsideAborted(page);
  await stationResponse(page, async (route) => route.fulfill({
    json: { station: { ...normalStation(STATION_ID + 777), stationId: STATION_ID + 777 } },
  }));
  await planFresh(page);
  const details = page.locator('.stop-card').first().locator('[data-station-evidence]');
  await page.getByRole('button', { name: 'Revalidate', exact: true }).first().click();
  await expect(details.locator('[data-station-evidence-status]')).toContainText('unavailable right now');
  await expect(details.locator('[data-station-evidence-result]')).toHaveCount(0);
});

test('a late response cannot write into a disconnected evidence view', async ({ page }) => {
  await outsideAborted(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let fetches = 0;
  await stationResponse(page, async (route) => {
    fetches++;
    await held;
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    await route.fulfill({ json: { station: normalStation(id) } });
  });
  await planFresh(page);
  const oldDetails = page.locator('.stop-card').first().locator('[data-station-evidence]');
  await page.getByRole('button', { name: 'Revalidate', exact: true }).first().click();
  await expect.poll(() => fetches).toBe(1);
  await expect(oldDetails.locator('[data-station-evidence-status]')).toContainText('Fetching');

  // Replanning replaces the result cards while the first fetch is still held.
  await page.getByRole('button', { name: 'Plan route', exact: true }).click();
  await expect(page.locator('[data-journey-briefing]')).toBeVisible();
  release();
  await expect(page.locator('.stop-card').first().locator('[data-station-evidence-result]')).toHaveCount(0);
  await expect(page.locator('[data-journey-briefing]')).toContainText('Journey briefing');
  expect(fetches).toBe(1);
});

test('failed manual fetch leaves retry available and never installs a wrong station result', async ({ page }) => {
  await outsideAborted(page);
  let fetches = 0;
  await stationResponse(page, async (route) => {
    fetches++;
    if (fetches === 1) return route.fulfill({ status: 503, json: { error: 'Manual fetch failed' } });
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    await route.fulfill({ json: { station: { ...normalStation(STATION_ID + 999), stationId: id } } });
  });
  await planFresh(page);
  const details = page.locator('.stop-card').first().locator('[data-station-evidence]');
  const button = page.getByRole('button', { name: 'Revalidate', exact: true }).first();

  await button.click();
  await expect(details.locator('[data-station-evidence-status]')).toContainText('unavailable right now');
  expect(fetches).toBe(1);
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => fetches).toBe(2);
  await expect(details.locator('[data-station-evidence-result]')).toHaveAttribute('data-evidence-station-id', String(STATION_ID));
  expect(fetches).toBe(2);
});
