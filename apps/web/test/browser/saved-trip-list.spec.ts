import { expect, test } from '@playwright/test';

function savedTrip(id: string, name: string, createdAt: string, origin: string, destination: string) {
  return {
    id, name, createdAt,
    origin: { label: origin, lat: 28.6, lon: 77.2 },
    destination: { label: destination, lat: 26.9, lon: 75.8 },
    routeDistanceKm: 280,
    geometry: [[28.6, 77.2], [26.9, 75.8]],
    vehicle: { label: 'Fixture EV' },
    totals: { totalTimeMin: 210, chargeTimeMin: 20, finalSocPct: 25 },
    stations: [],
  };
}

test('saved trips search, sort and clear preserve original record identity', async ({ page }, info) => {
  let tripReads = 0;
  let tripWrites = 0;
  const unexpected: string[] = [];
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  for (const path of ['**/api/plan', '**/api/ai/plan', '**/api/geocode*', '**/api/stations/*']) {
    await page.route(path, (route) => {
      unexpected.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 500, body: 'unexpected request' });
    });
  }
  const trips = [
    savedTrip('yankee', 'Yankee', '2026-01-03T00:00:00Z', 'Delhi', 'Jaipur'),
    savedTrip('beta', 'Beta', '2026-01-01T00:00:00Z', 'Pune', 'Goa'),
    savedTrip('zulu', 'Zulu', '2026-01-02T00:00:00Z', 'Chennai', 'Mumbai'),
  ];
  await page.route('**/api/trips', async (route) => {
    if (route.request().method() === 'GET') tripReads += 1;
    else tripWrites += 1;
    await route.fulfill({ json: { trips } });
  });
  await page.goto('/');
  await page.locator('#trips-button').click();

  const names = page.locator('.trip-row .trip-name');
  await expect(page.locator('[data-trip-result-count]')).toHaveText('Showing 3 of 3 saved trips.');
  await expect(names).toHaveText(['Yankee', 'Zulu', 'Beta']);
  const geometry = await page.locator('.trip-row').first().evaluate((row) => ({
    row: row.getBoundingClientRect().width,
    main: row.querySelector<HTMLElement>('.trip-main')?.getBoundingClientRect().width ?? 0,
    actions: row.querySelector<HTMLElement>('.trip-actions')?.getBoundingClientRect().width ?? 0,
  }));
  expect(geometry.main).toBeGreaterThan(geometry.row * 0.6);
  expect(geometry.actions).toBeLessThanOrEqual(geometry.row);
  const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(pageOverflow).toBeLessThanOrEqual(1);
  const sortBox = await page.locator('[data-trip-sort]').evaluate((select) => {
    const box = select.getBoundingClientRect();
    return { width: box.width, parent: select.parentElement?.getBoundingClientRect().width ?? 0, scroll: select.scrollWidth, client: select.clientWidth };
  });
  expect(sortBox.width).toBeGreaterThan(sortBox.parent * 0.7);
  expect(sortBox.scroll).toBeLessThanOrEqual(sortBox.client + 1);
  await page.screenshot({ path: info.outputPath('saved-trip-controls-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('saved-trip-controls-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.locator('[data-trip-search]').fill('goa');
  await expect(names).toHaveText(['Beta']);
  await expect(page.locator('[data-trip-result-count]')).toHaveText('Showing 1 of 3 saved trips.');
  await expect(page.locator('[data-trip-search-clear]')).toBeEnabled();
  await page.locator('[data-trip-search-clear]').click();
  await expect(page.locator('[data-trip-search]')).toHaveValue('');
  await expect(page.locator('[data-trip-search-clear]')).toBeDisabled();
  await expect(names).toHaveText(['Yankee', 'Zulu', 'Beta']);

  await page.locator('[data-trip-sort]').selectOption('oldest');
  await expect(names).toHaveText(['Beta', 'Zulu', 'Yankee']);
  await page.locator('[data-trip-sort]').selectOption('name');
  await expect(names).toHaveText(['Beta', 'Yankee', 'Zulu']);
  await expect(page.locator('.trip-row').first().locator('[data-compare-toggle]'))
    .toHaveAttribute('data-compare-index', '1');
  await page.screenshot({ path: info.outputPath('saved-trip-list-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('saved-trip-list-mobile.png') });

  await page.locator('.trip-row').first().getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('.plan-results .plan-route')).toContainText('Pune → Goa');
  expect(tripReads).toBe(1);
  expect(tripWrites).toBe(0);
  expect(unexpected).toEqual([]);
});

test('hidden comparison selection recovers after clearing a filtered list', async ({ page }) => {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  const trips = [
    savedTrip('yankee', 'Yankee', '2026-01-03T00:00:00Z', 'Delhi', 'Jaipur'),
    savedTrip('beta', 'Beta', '2026-01-01T00:00:00Z', 'Pune', 'Goa'),
    savedTrip('zulu', 'Zulu', '2026-01-02T00:00:00Z', 'Chennai', 'Mumbai'),
  ];
  await page.route('**/api/trips', (route) => route.fulfill({ json: { trips } }));
  await page.goto('/');
  await page.locator('#trips-button').click();

  const compare = page.locator('[data-compare-selected]');
  const notice = page.locator('.hidden-selection-notice');
  const row = (name: string) => page.locator('.trip-row').filter({ hasText: name });
  await expect(compare).toBeDisabled();
  await expect(notice).toBeHidden();
  await row('Yankee').getByRole('button', { name: 'Select to compare' }).click();
  await row('Beta').getByRole('button', { name: 'Select to compare' }).click();
  await expect(compare).toHaveText('Compare selected (2/2)');

  await page.locator('[data-trip-search]').fill('mumbai');
  await expect(page.locator('.trip-row .trip-name')).toHaveText(['Zulu']);
  await expect(notice).toContainText('2 selected trips hidden');
  await compare.click();
  await expect(page.locator('[data-trip-compare]')).toBeVisible();
  await page.locator('[data-compare-clear]').click();
  await expect(notice).toBeHidden();
  await expect(compare).toBeDisabled();
  await expect(page.locator('[data-trip-result-count]')).toHaveText('Showing 1 of 3 saved trips.');

  await page.locator('[data-trip-search]').fill('nothing matches');
  await expect(page.locator('.trip-row')).toHaveCount(0);
  await expect(page.locator('.trip-list')).toContainText('No saved trips match the current filters.');
  await expect(page.locator('[data-trip-result-count]')).toHaveText('Showing 0 of 3 saved trips.');
  await page.locator('[data-trip-search-clear]').click();
  await expect(page.locator('.trip-row .trip-name')).toHaveText(['Yankee', 'Zulu', 'Beta']);
  await expect(page.locator('[data-trip-result-count]')).toHaveText('Showing 3 of 3 saved trips.');
});

test('saved trip list load states stay distinct from an empty list', async ({ page }) => {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let status = 202;
  let body: Record<string, unknown> = { trips: [] };
  await page.route('**/api/trips', async (route) => {
    if (status === 202) await held;
    await route.fulfill({ status, json: body });
  });
  await page.goto('/');
  await page.locator('#trips-button').click();
  const search = page.locator('[data-trip-search]');
  const sort = page.locator('[data-trip-sort]');
  const count = page.locator('[data-trip-result-count]');
  await expect(page.locator('.trip-list')).toContainText('Loading…');
  await expect(search).toBeDisabled();
  await expect(sort).toBeDisabled();
  await expect(page.locator('[data-trip-search-clear]')).toBeDisabled();

  status = 200;
  body = { trips: {} };
  release();
  await expect(count).toHaveText('Saved trip list is unavailable.');
  await expect(page.locator('.trip-list')).toContainText('Saved trip list is unavailable.');
  await expect(search).toBeDisabled();
  await expect(sort).toBeDisabled();

  status = 503;
  body = { error: 'trips temporarily offline' };
  await page.reload();
  await page.locator('#trips-button').click();
  await expect(count).toHaveText('Saved trips could not be loaded.');
  await expect(page.locator('.trip-list')).toContainText('Could not load trips: trips temporarily offline');
  await expect(search).toBeDisabled();
  await expect(sort).toBeDisabled();
});

test('selection survives reordering and removal updates the hidden notice', async ({ page }) => {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  const trips = [
    savedTrip('yankee', 'Yankee', '2026-01-03T00:00:00Z', 'Delhi', 'Jaipur'),
    savedTrip('beta', 'Beta', '2026-01-01T00:00:00Z', 'Pune', 'Goa'),
    savedTrip('zulu', 'Zulu', '2026-01-02T00:00:00Z', 'Chennai', 'Mumbai'),
  ];
  await page.route('**/api/trips', (route) => route.fulfill({ json: { trips } }));
  await page.goto('/');
  await page.locator('#trips-button').click();
  const compare = page.locator('[data-compare-selected]');
  const notice = page.locator('.hidden-selection-notice');
  const row = (name: string) => page.locator('.trip-row').filter({ hasText: name });

  await page.locator('[data-trip-sort]').selectOption('name');
  await row('Beta').getByRole('button', { name: 'Select to compare' }).click();
  await expect(compare).toHaveText('Compare selected (1/2)');
  await page.locator('[data-trip-search]').fill('zulu');
  await expect(notice).toContainText('1 selected trip hidden');
  await page.locator('[data-trip-search-clear]').click();
  await expect(row('Beta').locator('[data-compare-toggle]')).toHaveAttribute('aria-pressed', 'true');

  await row('Zulu').getByRole('button', { name: 'Select to compare' }).click();
  await page.locator('[data-trip-search]').fill('goa');
  await expect(notice).toContainText('1 selected trip hidden');
  await compare.click();
  await expect(page.locator('[data-trip-compare]')).toBeVisible();
  await page.locator('[data-compare-remove="B"]').click();
  await expect(notice).toBeHidden();
  await expect(compare).toBeDisabled();
  await expect(page.locator('[data-trip-search]')).toHaveValue('goa');
});

test('filtered and sorted Edit/Delete actions target their original saved records', async ({ page }) => {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  const unexpected: string[] = [];
  let planRequests = 0;
  let deleteMethod: string | null = null;
  let deletePath: string | null = null;
  const trips = [
    savedTrip('yankee', 'Yankee', '2026-01-03T00:00:00Z', 'Delhi', 'Jaipur'),
    savedTrip('beta', 'Beta', '2026-01-01T00:00:00Z', 'Pune', 'Goa'),
    savedTrip('zulu', 'Zulu', '2026-01-02T00:00:00Z', 'Chennai', 'Mumbai'),
  ];
  await page.route('**/api/vehicles', (route) => route.fulfill({ json: { default: null, catalog: [] } }));
  await page.route('**/api/trips', (route) => {
    if (route.request().method() !== 'GET') unexpected.push('trip write');
    return route.fulfill({ json: { trips } });
  });
  await page.route('**/api/trips/*', async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    deleteMethod = route.request().method();
    deletePath = new URL(route.request().url()).pathname;
    await route.fulfill({ json: { ok: true } });
  });
  for (const path of ['**/api/plan', '**/api/ai/plan', '**/api/geocode*', '**/api/stations/*']) {
    await page.route(path, (route) => {
      if (path === '**/api/plan') planRequests += 1;
      unexpected.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 500, body: 'unexpected request' });
    });
  }
  await page.goto('/');
  await page.locator('#trips-button').click();
  const row = (name: string) => page.locator('.trip-row').filter({ hasText: name });
  await page.locator('[data-trip-sort]').selectOption('name');
  await page.locator('[data-trip-search]').fill('goa');
  await row('Beta').getByRole('button', { name: 'Edit route', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'From', exact: true })).toHaveValue('Pune');
  await expect(page.getByRole('combobox', { name: 'To', exact: true })).toHaveValue('Goa');
  await expect(page.locator('.plan-results')).toHaveCount(0);

  await page.locator('#trips-button').click();
  await page.locator('[data-trip-sort]').selectOption('name');
  await page.locator('[data-trip-search]').fill('mumbai');
  await row('Zulu').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => deletePath).toBe('/api/trips/zulu');
  expect(deleteMethod).toBe('DELETE');
  expect(planRequests).toBe(0);
  expect(unexpected).toEqual([]);
});

test('drawer query and sort survive close and reopen but not a page reload', async ({ page }, info) => {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  const trips = [
    savedTrip('yankee', 'Yankee', '2026-01-03T00:00:00Z', 'Delhi', 'Jaipur'),
    savedTrip('beta', 'Beta', '2026-01-01T00:00:00Z', 'Pune', 'Goa'),
    savedTrip('zulu', 'Zulu', '2026-01-02T00:00:00Z', 'Chennai', 'Mumbai'),
  ];
  await page.route('**/api/trips', (route) => route.fulfill({ json: { trips } }));
  await page.goto('/');
  await page.locator('#trips-button').click();
  const search = page.locator('[data-trip-search]');
  const sort = page.locator('[data-trip-sort]');
  await search.fill('goa');
  await sort.selectOption('name');
  await expect(page.locator('.trip-row .trip-name')).toHaveText(['Beta']);
  await page.locator('[data-close]').click();
  await expect(page.locator('#trips-drawer')).toBeHidden();

  await page.locator('#trips-button').click();
  await expect(search).toHaveValue('goa');
  await expect(sort).toHaveValue('name');
  await expect(page.locator('.trip-row .trip-name')).toHaveText(['Beta']);
  await expect(page.locator('[data-trip-result-count]')).toHaveText('Showing 1 of 3 saved trips.');
  await page.screenshot({ path: info.outputPath('saved-trip-list-restored-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('saved-trip-list-restored-mobile.png') });

  await page.locator('[data-trip-search-clear]').focus();
  await page.keyboard.press('Enter');
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(page.locator('.trip-row .trip-name')).toHaveText(['Beta', 'Yankee', 'Zulu']);

  await page.reload();
  await page.locator('#trips-button').click();
  await expect(search).toHaveValue('');
  await expect(sort).toHaveValue('newest');
});

test('successful deletion keeps the query and drops a deleted comparison selection', async ({ page }) => {
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  let trips = [
    savedTrip('yankee', 'Yankee', '2026-01-03T00:00:00Z', 'Delhi', 'Jaipur'),
    savedTrip('beta', 'Beta', '2026-01-01T00:00:00Z', 'Pune', 'Goa'),
    savedTrip('zulu', 'Zulu', '2026-01-02T00:00:00Z', 'Chennai', 'Mumbai'),
  ];
  let deletePath: string | null = null;
  await page.route('**/api/trips', (route) => route.fulfill({ json: { trips } }));
  await page.route('**/api/trips/*', async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    deletePath = new URL(route.request().url()).pathname;
    trips = trips.filter((trip) => trip.id !== 'zulu');
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  await page.locator('#trips-button').click();
  const row = page.locator('.trip-row').filter({ hasText: 'Zulu' });
  const compare = page.locator('[data-compare-selected]');
  await page.locator('[data-trip-search]').fill('zulu');
  await expect(page.locator('.trip-row .trip-name')).toHaveText(['Zulu']);
  await row.getByRole('button', { name: 'Select to compare' }).click();
  await expect(compare).toHaveText('Compare selected (1/2)');

  await row.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => deletePath).toBe('/api/trips/zulu');
  await expect(page.locator('[data-trip-search]')).toHaveValue('zulu');
  await expect(page.locator('[data-trip-result-count]')).toHaveText('Showing 0 of 2 saved trips.');
  await expect(page.locator('.trip-list')).toContainText('No saved trips match the current filters.');
  await expect(compare).toHaveText('Compare selected (0/2)');
  await expect(compare).toBeDisabled();
  await expect(page.locator('.hidden-selection-notice')).toBeHidden();
});
