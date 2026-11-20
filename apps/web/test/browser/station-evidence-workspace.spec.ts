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

function savedEvidenceTrip(stationId: number, name: string) {
  return {
    id: `evidence-${stationId}`, name, createdAt: '2026-11-20T10:00:00Z',
    source: 'live', status: 'ok', origin: ORIGIN, destination: DESTINATION,
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
      stationId, name, lat: 27.5, lon: 76.5,
      chainageKm: 160, legKm: 162, detourKm: 2,
      arriveSocPct: 20, leaveSocPct: 80, chargeKwh: 42.7,
      pricePerKwh: 22.75, estPriceInr: 854, chargeTimeMin: 42,
    }],
  };
}

async function openSavedTripByIndex(page: import('@playwright/test').Page, index: number): Promise<void> {
  await page.goto('/');
  await page.locator('#trips-button').click();
  await page.getByRole('button', { name: 'Open', exact: true }).nth(index).click();
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
  const fetched = details.locator('[data-station-evidence-fetched]');
  await expect(details.locator('[data-station-evidence-status]')).toContainText('Response received');
  await expect(fetched.locator('[data-station-evidence-result]')).toHaveAttribute('data-evidence-station-id', String(requestedId));
  await expect(fetched.locator('[data-station-evidence-result]')).toContainText('Rs. 22.75/kWh');
  await expect(fetched.locator('[data-station-evidence-result]')).toContainText('Working · free');
  await expect(fetched.locator('[data-station-evidence-result]')).toContainText('Faulted');
  await expect(fetched.locator('[data-station-evidence-result]')).toContainText('1 usable');
  await expect(fetched.locator('[data-station-evidence-result]')).toContainText('1 free');
  await expect(fetched.locator('[data-station-evidence-result]')).toContainText('18/11/2026');
  await expect(fetched).toContainText('Snapshot fetched at');
  await expect(fetched.locator('dd.fetched')).toContainText('Nov 2026');
  await expect(fetched.locator('dd.fetched')).not.toContainText('just now');
  await expect(fetched).toContainText('Response received');
  await expect(fetched).toContainText('(this browser)');
  await expect(details.locator('.evidence-station')).toContainText('Planned charger snapshot');
  expect(fetches).toBe(1);
  await details.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('station-evidence-fresh-normal.png') });

  await page.emulateMedia({ media: 'print' });
  await expect(details).toBeHidden();
  await expect(page.locator('[data-journey-briefing]')).toBeVisible();
  await expect(page.locator('#map')).toBeHidden();
  expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('station-evidence-print-details-open.png'), fullPage: true });
  await page.emulateMedia({ media: 'screen' });
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
  const result = details.locator('[data-station-evidence-fetched] [data-station-evidence-result]');
  await expect(result).toContainText('3 · 7 reviews');
  await expect(result).toContainText('Uncertain');
  await expect(result).toContainText('Unknown');
  await expect(details.locator('[data-station-evidence-status]')).toContainText('snapshot time is not verified');
  await expect(result.locator('[data-malformed-proof]')).toHaveCount(0);
  await expect(page.locator('img[onerror=malformed]')).toHaveCount(0);
  await details.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('station-evidence-malformed-mobile.png') });
});

for (const idMode of ['same', 'different'] as const) {
  test(`reopening a saved trip with a ${idMode} station ID during a held fetch discards the old response`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await outsideAborted(page);
    let fetches = 0;
    let completedFetches = 0;
    let storageWrites = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const replacementId = idMode === 'same' ? STATION_ID : STATION_ID + 55;
    const savedTrips = [savedEvidenceTrip(STATION_ID, 'Held stop'), savedEvidenceTrip(replacementId, 'Reopened stop')];
    await page.route('**/api/trips', async (route) => {
      if (route.request().method() === 'GET') await route.fulfill({ json: { trips: savedTrips } });
      else {
        storageWrites++;
        await route.fulfill({ status: 200, json: { ok: true } });
      }
    });
    await stationResponse(page, async (route) => {
      fetches++;
      await held;
      const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
      await route.fulfill({ json: { station: normalStation(id) } });
      completedFetches++;
    });

    await openSavedTripByIndex(page, 0);
    const first = page.locator('.saved-stop').first();
    await expect(first.locator('[data-station-evidence-status]')).toContainText('No current status requested');
    expect(fetches).toBe(0);
    await page.getByRole('button', { name: 'Fetch current details', exact: true }).click();
    await expect.poll(() => fetches).toBe(1);
    await expect(first.locator('[data-station-evidence-status]')).toContainText('Fetching');

    await page.locator('#trips-button').click();
    await page.getByRole('button', { name: 'Open', exact: true }).nth(1).click();
    const reopened = page.locator('.saved-stop').first();
    await expect(reopened.locator('[data-station-evidence]')).toHaveAttribute('data-station-id', String(replacementId));
    await expect(reopened.locator('[data-station-evidence-status]')).toContainText('No current status requested');
    await expect(reopened.locator('[data-station-evidence-fetched] [data-station-evidence-result]')).toHaveCount(0);

    release();
    await expect.poll(() => completedFetches).toBe(1);
    await expect(reopened.locator('[data-station-evidence-status]')).toContainText('No current status requested');
    await expect(reopened.locator('[data-station-evidence-fetched] [data-station-evidence-result]')).toHaveCount(0);
    expect(fetches).toBe(1);
    expect(storageWrites).toBe(0);
  });
}

test('switching from a held fresh fetch to a saved trip discards the old response', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await outsideAborted(page);
  let fetches = 0;
  let completedFetches = 0;
  let storageWrites = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await stationResponse(page, async (route) => {
    fetches++;
    await held;
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    await route.fulfill({ json: { station: normalStation(id) } });
    completedFetches++;
  });
  await page.route('**/api/trips', async (route) => {
    if (route.request().method() === 'GET') await route.fulfill({ json: { trips: [savedEvidenceTrip(STATION_ID + 55, 'Saved switch target')] } });
    else {
      storageWrites++;
      await route.fulfill({ status: 200, json: { ok: true } });
    }
  });
  await planFresh(page);
  await page.getByRole('button', { name: 'Revalidate', exact: true }).first().click();
  await expect.poll(() => fetches).toBe(1);
  await expect(page.locator('.stop-card').first().locator('[data-station-evidence-status]')).toContainText('Fetching');

  await page.locator('#trips-button').click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  const savedDetails = page.locator('.saved-stop').first().locator('[data-station-evidence]');
  await expect(page.locator('.stop-card')).toHaveCount(1);
  await expect(savedDetails).toHaveAttribute('data-station-id', String(STATION_ID + 55));
  await expect(savedDetails.locator('[data-station-evidence-status]')).toContainText('No current status requested');

  release();
  await expect.poll(() => completedFetches).toBe(1);
  await expect(savedDetails.locator('[data-station-evidence-status]')).toContainText('No current status requested');
  await expect(savedDetails.locator('[data-station-evidence-fetched] [data-station-evidence-result]')).toHaveCount(0);
  expect(fetches).toBe(1);
  expect(storageWrites).toBe(0);
});

test('reopening saved trips with same and different IDs uses each own evidence controller', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await outsideAborted(page);
  let fetches = 0;
  let completedFetches = 0;
  const savedTrips = [
    { ...savedEvidenceTrip(STATION_ID, 'Saved stop A') },
    { ...savedEvidenceTrip(STATION_ID + 55, 'Saved stop B') },
  ];
  await page.route('**/api/trips', async (route) => {
    if (route.request().method() !== 'GET') throw new Error('Unexpected trip write');
    await route.fulfill({ json: { trips: savedTrips } });
  });
  await stationResponse(page, async (route) => {
    fetches++;
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    await route.fulfill({ json: { station: normalStation(id) } });
    completedFetches++;
  });

  await openSavedTripByIndex(page, 0);
  const first = page.locator('.saved-stop').first();
  await expect(first.locator('[data-station-evidence]')).toHaveAttribute('data-station-id', String(STATION_ID));
  await page.getByRole('button', { name: 'Fetch current details', exact: true }).first().click();
  await expect.poll(() => completedFetches).toBe(1);
  await expect(first.locator('[data-station-evidence-status]')).toContainText('Response received');
  await expect(first.locator('[data-station-evidence-fetched] [data-station-evidence-result]'))
    .toHaveAttribute('data-evidence-station-id', String(STATION_ID));

  await page.locator('#trips-button').click();
  await page.getByRole('button', { name: 'Open', exact: true }).nth(1).click();
  const second = page.locator('.saved-stop').first();
  await expect(second.locator('[data-station-evidence]')).toHaveAttribute('data-station-id', String(STATION_ID + 55));
  await expect(second.locator('[data-station-evidence-status]')).toContainText('No current status requested');
  await page.getByRole('button', { name: 'Fetch current details', exact: true }).first().click();
  await expect.poll(() => completedFetches).toBe(2);
  await expect(second.locator('[data-station-evidence-fetched] [data-station-evidence-result]'))
    .toHaveAttribute('data-evidence-station-id', String(STATION_ID + 55));
  await expect(first).toHaveCount(0);
  expect(fetches).toBe(2);
});

test('switching from fresh plan to saved trip keeps separate evidence state', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await outsideAborted(page);
  let fetches = 0;
  let completedFetches = 0;
  await stationResponse(page, async (route) => {
    fetches++;
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    await route.fulfill({ json: { station: normalStation(id) } });
    completedFetches++;
  });
  await page.route('**/api/trips', async (route) => {
    if (route.request().method() !== 'GET') throw new Error('Unexpected trip write');
    await route.fulfill({ json: { trips: [savedEvidenceTrip(STATION_ID + 55, 'Saved after fresh')] } });
  });
  await planFresh(page);
  const freshDetails = page.locator('.stop-card').first().locator('[data-station-evidence]');
  await page.getByRole('button', { name: 'Revalidate', exact: true }).first().click();
  await expect.poll(() => completedFetches).toBe(1);
  await expect(freshDetails.locator('[data-station-evidence-status]')).toContainText('Response received');

  await page.locator('#trips-button').click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('.stop-card')).toHaveCount(1);
  const savedDetails = page.locator('.saved-stop').first().locator('[data-station-evidence]');
  await expect(savedDetails.locator('[data-station-evidence-status]')).toContainText('No current status requested');
  await expect(savedDetails.locator('[data-station-id]')).toHaveAttribute('data-station-id', String(STATION_ID + 55));
  await page.getByRole('button', { name: 'Fetch current details', exact: true }).click();
  await expect.poll(() => completedFetches).toBe(2);
  await expect(savedDetails.locator('[data-station-evidence-fetched] [data-station-evidence-result]'))
    .toHaveAttribute('data-evidence-station-id', String(STATION_ID + 55));
  expect(fetches).toBe(2);
});

test('one malformed planned stop does not suppress other cards or evidence panels', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await outsideAborted(page);
  await page.route('**/api/plan', async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { plan: {
      stops: Array<{ station: Record<string, unknown> }>;
    } };
    const first = body.plan.stops[0];
    if (first) {
      delete first.station.chargers;
      first.station.brand = '';
    }
    const second = body.plan.stops[1];
    const secondChargers = second?.station.chargers as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(secondChargers) && secondChargers[0]) delete secondChargers[0].plugs;
    await route.fulfill({ response, json: body });
  });
  await planFresh(page);

  const cards = page.locator('.stop-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText('Last used Unknown');
  await expect(cards.first()).toContainText('Charger inventory Unknown');
  await expect(cards.first().locator('.stop-brand')).toHaveText('Unknown');
  await expect(cards.first().locator('.stop-brand')).toHaveClass(/brand-other/);
  await expect(cards.first().locator('[data-station-evidence]')).toBeVisible();
  await expect(cards.first().locator('[data-station-evidence]')).toContainText(
    'Charger snapshot unavailable — the planned charger list is Unknown.',
  );
  await expect(cards.nth(1).locator('[data-station-evidence]')).toBeVisible();
  await expect(cards.nth(1)).toContainText('Plug inventory Unknown');
  await expect(cards.nth(1)).not.toContainText('No CCS2 DC found for this car');
  await expect(page.locator('[data-journey-briefing]')).toBeVisible();
  await expect(page.locator('[data-review-proof]')).toHaveCount(0);
  await cards.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('station-evidence-missing-inventory-mobile.png') });
});

test('manual fetch leaves fresh plan facts unchanged and writes no trip', async ({ page }) => {
  await outsideAborted(page);
  let storageWrites = 0;
  await page.route('**/api/plan', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  await page.route('**/api/trips', async (route) => {
    storageWrites++;
    await route.fulfill({ json: { trips: [] }, status: 200 });
  });
  await stationResponse(page, async (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    await route.fulfill({ json: { station: normalStation(id) } });
  });
  await planFresh(page);
  const details = page.locator('.stop-card').first().locator('[data-station-evidence]');
  await details.locator('summary').click();
  const plannedBefore = await details.locator('.evidence-station').innerText();
  await page.getByRole('button', { name: 'Revalidate', exact: true }).first().click();
  await expect(details.locator('[data-station-evidence-status]')).toContainText('Response received');
  expect(await details.locator('.evidence-station').innerText()).toBe(plannedBefore);
  expect(storageWrites).toBe(0);
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
  const result = details.locator('[data-station-evidence-fetched] [data-station-evidence-result]');
  await expect(result).toContainText('Synthetic station — fixed sample, not live charger data.');
  await expect(details.locator('[data-station-evidence-status]')).toContainText('availability is not guaranteed live');
  await details.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('station-evidence-synthetic-mobile.png') });
});

test('saved trip shows stored facts separately from its one manual evidence fetch', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await outsideAborted(page);
  let fetches = 0;
  let storageWrites = 0;
  const savedTrip = {
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
  };
  const originalSavedTrip = JSON.stringify(savedTrip);
  await page.route('**/api/trips', async (route) => {
    if (route.request().method() === 'GET') await route.fulfill({ json: { trips: [savedTrip] } });
    else {
      storageWrites++;
      await route.fulfill({ status: 200, json: { ok: true } });
    }
  });
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
  const plannedBefore = await details.locator('.evidence-station').innerText();
  await expect(details).toContainText('Planned snapshot from the trip');
  await expect(details).toContainText('Rs. 22.75/kWh');
  await expect(details).toContainText('42.7 kWh');
  await expect(details).toContainText('This saved trip stores planned charging facts, not a charger snapshot');
  await expect(details.locator('[data-station-evidence-fetched] [data-station-evidence-result]')).toHaveCount(0);
  expect(fetches).toBe(0);

  await page.getByRole('button', { name: 'Fetch current details', exact: true }).click();
  await expect.poll(() => fetches).toBe(1);
  await expect(details.locator('[data-station-evidence-status]')).toContainText('Response received');
  await expect(details.locator('[data-station-evidence-fetched] [data-station-evidence-result]')).toContainText('Working · free');
  await expect(details.locator('.evidence-station')).toContainText('This saved trip stores planned charging facts, not a charger snapshot');
  // Browser-state proof is the unchanged evidence DOM plus zero write calls;
  // the fixture snapshot is only a supplemental Node-side guard.
  expect(await details.locator('.evidence-station').innerText()).toBe(plannedBefore);
  expect(JSON.stringify(savedTrip)).toBe(originalSavedTrip);
  expect(storageWrites).toBe(0);
  expect(fetches).toBe(1);
  await details.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('station-evidence-saved-mobile.png') });
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  for (const listShape of ['zero', 'unknown'] as const) {
    test(`hostile long strings and ${listShape} charger list render safely at ${viewport.width}px`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      await outsideAborted(page);
      const longText = '<img src=x onerror=stationProof>' + ' hostile-value '.repeat(24);
      await page.route('**/api/plan', async (route) => {
        const response = await route.fetch();
        const body = await response.json() as {
          plan: { stops: Array<{ station: Record<string, unknown> }> };
        };
        const stop = body.plan.stops[0];
        if (stop) {
          stop.station.name = longText;
          stop.station.stationUrl = 'javascript:stationProof';
          delete stop.station.chargers;
        }
        await route.fulfill({ response, json: body });
      });
      await stationResponse(page, async (route) => {
        const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
        const station: Record<string, unknown> = {
          stationId: id, name: longText, address: longText, city: longText,
          hours: longText, openText: longText, rating: 4, reviewCount: 9,
          fetchedAt: '2026-11-20T10:15:00.000Z',
        };
        if (listShape === 'zero') station.chargers = [];
        await route.fulfill({ json: { station } });
      });
      await planFresh(page);
      const details = page.locator('.stop-card').first().locator('[data-station-evidence]');
      await details.locator('summary').click();
      await expect(details).toContainText('Charger snapshot unavailable — the planned charger list is Unknown.');
      await page.getByRole('button', { name: 'Revalidate', exact: true }).first().click();
      const result = details.locator('[data-station-evidence-fetched] [data-station-evidence-result]');
      await expect(result).toContainText(listShape === 'zero' ? 'No chargers returned.' : 'Charger list is Unknown.');
      await expect(result).toContainText('Snapshot fetched at');
      await expect(result).toContainText('Response received');
      await expect(result.locator('dd.fetched')).toContainText('Nov 2026');
      await expect(page.locator('img[onerror=stationProof]')).toHaveCount(0);
      expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await details.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`station-evidence-hostile-${listShape}-${viewport.width}.png`) });
    });
  }
}

test('a wrong station ID in the response is refused and never rendered', async ({ page }) => {
  await outsideAborted(page);
  await stationResponse(page, async (route) => route.fulfill({
    json: { station: { ...normalStation(STATION_ID + 777), stationId: STATION_ID + 777 } },
  }));
  await planFresh(page);
  const details = page.locator('.stop-card').first().locator('[data-station-evidence]');
  await page.getByRole('button', { name: 'Revalidate', exact: true }).first().click();
  await expect(details.locator('[data-station-evidence-status]')).toContainText('unavailable right now');
  await expect(details.locator('[data-station-evidence-fetched] [data-station-evidence-result]')).toHaveCount(0);
});

test('a late response cannot write into a disconnected evidence view', async ({ page }) => {
  await outsideAborted(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let fetches = 0;
  let completedFetches = 0;
  await stationResponse(page, async (route) => {
    fetches++;
    await held;
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    await route.fulfill({ json: { station: normalStation(id) } });
    completedFetches++;
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
  await expect.poll(() => completedFetches).toBe(1);
  await expect(page.locator('.stop-card').first().locator('[data-station-evidence-status]')).toContainText('No current status requested');
  await expect(page.locator('.stop-card').first().locator('[data-station-evidence-fetched] [data-station-evidence-result]')).toHaveCount(0);
  await expect(page.locator('[data-journey-briefing]')).toContainText('Journey briefing');
  expect(fetches).toBe(1);
});

test('one manual request survives repeated clicks while a response is pending', async ({ page }) => {
  await outsideAborted(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let fetches = 0;
  let completedFetches = 0;
  await stationResponse(page, async (route) => {
    fetches++;
    await held;
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    await route.fulfill({ json: { station: normalStation(id) } });
    completedFetches++;
  });
  await planFresh(page);
  const button = page.getByRole('button', { name: 'Revalidate', exact: true }).first();
  await button.click();
  await expect.poll(() => fetches).toBe(1);
  await button.evaluate((element) => {
    for (let n = 0; n < 5; n++) element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await expect(button).toBeDisabled();
  expect(fetches).toBe(1);
  release();
  await expect.poll(() => completedFetches).toBe(1);
  await expect(page.locator('[data-station-evidence-status]').first()).toContainText('Response received');
  await expect(button).toBeEnabled();
  expect(fetches).toBe(1);
});

test('keyboard opens details without fetching and a focused input keeps focus when fetch settles', async ({ page }) => {
  await outsideAborted(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let fetches = 0;
  let completedFetches = 0;
  await stationResponse(page, async (route) => {
    fetches++;
    await held;
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    await route.fulfill({ json: { station: normalStation(id) } });
    completedFetches++;
  });
  await planFresh(page);
  const details = page.locator('.stop-card').first().locator('[data-station-evidence]');
  await details.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(details).toHaveAttribute('open', '');
  expect(fetches).toBe(0);

  await page.getByRole('button', { name: 'Revalidate', exact: true }).first().click();
  await expect.poll(() => fetches).toBe(1);
  const origin = page.getByRole('searchbox', { name: 'From', exact: true });
  await origin.focus();
  release();
  await expect.poll(() => completedFetches).toBe(1);
  await expect(details.locator('[data-station-evidence-status]')).toContainText('Response received');
  await expect(details.locator('[data-station-evidence-fetched] [data-station-evidence-result]')).toHaveCount(1);
  await expect(origin).toBeFocused();
  expect(fetches).toBe(1);
});

for (const replacement of ['same', 'different'] as const) {
  test(`a stale response cannot write into a ${replacement}-ID replacement view`, async ({ page }) => {
    await outsideAborted(page);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let plans = 0;
    let fetches = 0;
    let completedFetches = 0;
    await page.route('**/api/plan', async (route) => {
      plans++;
      const response = await route.fetch();
      const body = await response.json() as {
        plan: { stops: Array<{ station: { stationId: number; name: string } }> };
      };
      if (plans === 2 && replacement === 'different' && body.plan.stops[0]) {
        body.plan.stops[0].station.stationId = STATION_ID + 777;
      }
      await route.fulfill({ response, json: body });
    });
    await stationResponse(page, async (route) => {
      fetches++;
      await held;
      const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
      await route.fulfill({ json: { station: normalStation(id) } });
      completedFetches++;
    });
    await planFresh(page);
    await page.getByRole('button', { name: 'Revalidate', exact: true }).first().click();
    await expect.poll(() => fetches).toBe(1);

    await page.getByRole('button', { name: 'Plan route', exact: true }).click();
    await expect.poll(() => plans).toBe(2);
    const replacementId = replacement === 'same' ? STATION_ID : STATION_ID + 777;
    await expect(page.locator('.stop-card').first().locator('[data-refresh]')).toHaveAttribute('data-refresh', String(replacementId));
    await expect(page.locator('[data-journey-briefing]')).toBeVisible();
    const newCard = page.locator('.stop-card').first();
    const newDetails = newCard.locator('[data-station-evidence]');
    await expect(newCard.locator('[data-refresh]')).toHaveAttribute('data-refresh', String(replacementId));
    await expect(newDetails.locator('[data-station-evidence-status]')).toContainText('No current status requested');
    release();
    await expect.poll(() => completedFetches).toBe(1);
    await expect(newDetails.locator('[data-station-evidence-status]')).toContainText('No current status requested');
    await expect(newDetails.locator('[data-station-evidence-fetched] [data-station-evidence-result]')).toHaveCount(0);
    expect(fetches).toBe(1);
  });
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  for (const failure of ['network', 'http', 'non-json', 'malformed'] as const) {
  test(`${failure} manual fetch is announced, retryable, and installs no result at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await outsideAborted(page);
    let fetches = 0;
    let settled = 0;
    await stationResponse(page, async (route) => {
      fetches++;
      if (failure === 'network') await route.abort('failed');
      else if (failure === 'http') await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporarily unavailable"}' });
      else if (failure === 'non-json') await route.fulfill({ status: 200, contentType: 'text/html', body: '<html>not json</html>' });
      else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: 'wrong shape' }) });
      settled++;
    });
    await planFresh(page);
    const details = page.locator('.stop-card').first().locator('[data-station-evidence]');
    const button = page.getByRole('button', { name: 'Revalidate', exact: true }).first();
    await button.click();
    await expect.poll(() => settled).toBe(1);
    await expect(details.locator('[data-station-evidence-status]')).toHaveAttribute('role', 'status');
    await expect(details.locator('[data-station-evidence-status]')).toHaveAttribute('aria-live', 'polite');
    await expect.poll(() => details.locator('[data-station-evidence-status]').innerText()).toContain('unavailable right now');
    await expect(details.locator('[data-station-evidence-fetched] [data-station-evidence-result]')).toHaveCount(0);
    await expect(button).toBeEnabled();
    expect(fetches).toBe(1);
  });
  }
}

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
  // No automatic retry after the failed response settles.
  await page.waitForTimeout(150);
  expect(fetches).toBe(1);
  await button.click();
  await expect.poll(() => fetches).toBe(2);
  await expect(details.locator('[data-station-evidence-fetched] [data-station-evidence-result]')).toHaveAttribute('data-evidence-station-id', String(STATION_ID));
  expect(fetches).toBe(2);
});
