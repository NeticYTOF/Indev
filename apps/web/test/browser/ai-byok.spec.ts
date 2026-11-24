/**
 * Bring-your-own-key AI: the key is entered in the site, stored encrypted on
 * this device only, and sent only as a header on AI planning requests.
 */
import { expect, test, type Page, type Request } from '@playwright/test';

const KEY = 'sk-device-browser-9f8e7d6c5b';
const origin = { label: 'Delhi', lat: 28.6139, lon: 77.209 };
const destination = { label: 'Jaipur', lat: 26.9124, lon: 75.7873 };

function envelope() {
  return {
    plan: {
      id: 'byok-plan', createdAt: '2026-11-21T12:00:00Z', source: 'live', status: 'ok',
      origin, destination,
      vehicle: { label: 'Harrier', catalogId: 'harrier', batteryKwh: 75, claimedRangeKm: 627, realWorldRangeKm: 300 },
      routeDistanceKm: 285, routeDurationMin: 270,
      geometry: [{ lat: 28.6, lon: 77.2 }, { lat: 26.9, lon: 75.8 }],
      warnings: [], stationsSeen: 1,
      totals: { distanceKm: 285, driveTimeMin: 270, chargeTimeMin: 0, totalTimeMin: 270,
        chargeKwh: 0, estPriceInr: null, finalSocPct: 30 },
      stops: [],
    },
    ai: { applied: true, notes: 'Fixture selection.' },
  };
}

interface Started { headers: Record<string, string>; body: string }

async function wired(page: Page, health: Record<string, unknown> = {}): Promise<Started[]> {
  const started: Started[] = [];
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('https://tiles.openfreemap.org/styles/dark', (route) => route.fulfill({
    json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background' }] },
  }));
  await page.route('**/api/health', (route) => route.fulfill({
    json: { ok: true, mock: false, ai: false, aiByok: true, chargersSeen: 0,
      aiProviders: [
        { id: 'hackclub', label: 'Hack Club AI', defaultModel: 'z-ai/glm-5.3-flash' },
        { id: 'groq', label: 'Groq', defaultModel: 'llama-3.3-70b-versatile' },
      ], ...health },
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
  await page.route('**/api/jobs/plan', async (route) => {
    const req: Request = route.request();
    started.push({ headers: await req.allHeaders(), body: req.postData() ?? '' });
    return route.fulfill({ status: 202, json: { jobId: 'job-1', capability: 'cap', budget: { deadlineMs: 60_000, maxUpstreamCalls: 10 } } });
  });
  await page.route('**/api/jobs/plan/*', (route) => route.fulfill({
    json: { jobId: 'job-1', state: 'succeeded', startedAt: 1, finishedAt: 2, progress: null, result: envelope() },
  }));
  return started;
}

async function pickPlaces(page: Page) {
  for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
    await page.getByRole('combobox', { name, exact: true }).fill(query!);
    await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
  }
}

async function saveKey(page: Page) {
  const settings = page.locator('[data-ai-settings]');
  if (!(await settings.evaluate((d) => (d as HTMLDetailsElement).open))) {
    await settings.locator('summary').click();
  }
  await page.locator('#ai-key').fill(KEY);
  await page.getByRole('button', { name: 'Save key on this device' }).click();
  await expect(page.locator('[data-ai-key-status]')).toContainText('Key saved on this device (encrypted)');
}

test('AI planning without a key asks for one and sends nothing', async ({ page }) => {
  const started = await wired(page);
  await page.goto('/');
  await expect(page.locator('.ai-box')).toBeVisible();
  await pickPlaces(page);
  await page.getByRole('button', { name: 'Plan with AI', exact: true }).click();
  await expect(page.locator('.error-box')).toContainText('Add your AI API key in AI settings first');
  await expect(page.locator('#ai-key')).toBeFocused();
  expect(started).toHaveLength(0);
});

test('a saved key is encrypted at rest, survives reload, and is sent only as headers', async ({ page }) => {
  const started = await wired(page);
  await page.goto('/');
  await saveKey(page);
  await expect(page.locator('#ai-key')).toHaveValue('');
  await expect(page.locator('[data-ai-key-pill]')).toHaveText('Key saved');

  // Nothing readable anywhere in web storage or the DOM.
  const leaks = await page.evaluate(async (key) => {
    const found: string[] = [];
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        const k = store.key(i)!;
        if ((store.getItem(k) ?? '').includes(key)) found.push(`storage:${k}`);
      }
    }
    if (document.documentElement.outerHTML.includes(key)) found.push('dom');
    if (document.cookie.includes(key)) found.push('cookie');
    const records = await new Promise<unknown[]>((resolve, reject) => {
      const open = indexedDB.open('indeev-device');
      open.onsuccess = () => {
        const tx = open.result.transaction('secrets', 'readonly');
        const all = tx.objectStore('secrets').getAll();
        all.onsuccess = () => resolve(all.result);
        all.onerror = () => reject(all.error);
      };
      open.onerror = () => reject(open.error);
    });
    let sealedCount = 0;
    let wrapExtractable: boolean | null = null;
    for (const record of records) {
      if (record instanceof CryptoKey) { wrapExtractable = record.extractable; continue; }
      const sealed = record as { ciphertext: ArrayBuffer };
      sealedCount += 1;
      if (new TextDecoder().decode(new Uint8Array(sealed.ciphertext)).includes(key)) found.push('idb-plaintext');
    }
    return { found, sealedCount, wrapExtractable };
  }, KEY);
  expect(leaks.found).toEqual([]);
  expect(leaks.sealedCount).toBe(1);
  expect(leaks.wrapExtractable).toBe(false);

  await page.reload();
  await expect(page.locator('[data-ai-key-status]')).toContainText('Key saved on this device');
  await page.locator('[data-ai-settings] summary').click();
  await page.locator('#ai-provider').selectOption('groq');
  await page.locator('#ai-model').fill('llama-3.1-8b-instant');
  await page.locator('#ai-model').blur();
  await page.locator('#ai-request').fill('Prefer stops with cafes');
  await pickPlaces(page);
  await page.getByRole('button', { name: 'Plan with AI', exact: true }).click();
  await expect(page.locator('.plan-results')).toBeVisible({ timeout: 15_000 });
  expect(started).toHaveLength(1);
  const [first] = started;
  expect(first!.headers['x-indeev-ai-key']).toBe(KEY);
  expect(first!.headers['x-indeev-ai-provider']).toBe('groq');
  expect(first!.headers['x-indeev-ai-model']).toBe('llama-3.1-8b-instant');
  expect(first!.body).not.toContain(KEY);
  expect(JSON.parse(first!.body).request).toBe('Prefer stops with cafes');
  expect(page.url()).not.toContain(KEY);
});

test('rules-only runs never send the key; instructions persist; key can be removed', async ({ page }) => {
  const started = await wired(page);
  await page.goto('/');
  await saveKey(page);
  await page.locator('#ai-request').fill('Avoid single-plug stations');
  await page.waitForTimeout(500); // debounce persists instructions
  await page.reload();
  await expect(page.locator('#ai-request')).toHaveValue('Avoid single-plug stations');
  await pickPlaces(page);
  const thorough = page.locator('.planner-thorough');
  await expect(thorough).toBeVisible();
  await thorough.click();
  await expect.poll(() => started.length).toBe(1);
  expect(started[0]!.headers['x-indeev-ai-key']).toBeUndefined();
  await expect(page.locator('.plan-results')).toBeVisible({ timeout: 15_000 });

  await page.locator('[data-ai-settings] summary').click();
  await page.getByRole('button', { name: 'Remove key' }).click();
  await expect(page.locator('[data-ai-key-status]')).toContainText('Key removed from this device');
  await page.reload();
  await expect(page.locator('[data-ai-key-status]')).toContainText('No AI key saved on this device');
});

test('with a server key, AI runs without a device key and sends no key header', async ({ page }) => {
  const started = await wired(page, { ai: true });
  await page.goto('/');
  await expect(page.locator('[data-ai-key-pill]')).toHaveText('Server key');
  await pickPlaces(page);
  await page.getByRole('button', { name: 'Plan with AI', exact: true }).click();
  await expect.poll(() => started.length).toBe(1);
  expect(started[0]!.headers['x-indeev-ai-key']).toBeUndefined();
});
