import { expect, test } from '@playwright/test';
import { VEHICLE_CATALOG } from '@indeev/core';
import photoSources from '../../public/vehicle-photo-sources.json' with { type: 'json' };
import { safeHttpUrl } from '../../src/safe-url.js';

async function wire(page: import('@playwright/test').Page): Promise<void> {
  await page.route(/^https?:\/\//, async (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === 'localhost' || host === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.route('**/api/health', route => route.fulfill({
    json: { ok: true, mock: true, ai: false, chargersSeen: 0 },
  }));
  await page.route('**/api/vehicles', route => route.fulfill({
    json: { default: 'tata-harrier-ev-75', catalog: VEHICLE_CATALOG, note: 'fixture' },
  }));
}

const selectOf = (page: import('@playwright/test').Page) => page.locator('#vehicle-select');
const panelOf = (page: import('@playwright/test').Page) => page.locator('[data-vehicle-photo]');
const imageOf = (page: import('@playwright/test').Page) => panelOf(page).locator('img.vehicle-photo-image');
const href = (raw: string): string => safeHttpUrl(raw) ?? raw;

async function expectLoadedImage(page: import('@playwright/test').Page, id: string, alt: string): Promise<void> {
  const image = imageOf(page);
  await expect(image).toHaveAttribute('src', `/vehicles/${id}.webp`);
  await expect(image).toHaveAttribute('alt', `${alt} — illustrative vehicle photo.`);
  await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
}

test('vehicle photo panel shows the local default before any interaction', async ({ page }) => {
  await wire(page);
  await page.goto('/');
  await expectLoadedImage(page, 'tata-harrier-ev-75', 'Tata Harrier EV');
  await expect(selectOf(page)).toHaveValue('default');
  await expect(panelOf(page)).toContainText('Illustrative vehicle photo; exact model year, trim, colour and wheels may vary.');
});

for (const source of photoSources) {
  test(`preset ${source.id} shows its exact photo and credits`, async ({ page }) => {
    await wire(page);
    await page.goto('/');
    const value = source.id === 'tata-harrier-ev-75' ? 'default' : source.id;
    await selectOf(page).selectOption(value);
    await expect(selectOf(page)).toHaveValue(value);
    await expectLoadedImage(page, source.id, source.alt);
    const panel = panelOf(page);
    await expect(panel).toContainText(`Photo: ${source.author}`);
    await expect(panel).toContainText(source.license);
    await expect(panel).toContainText(source.changes);
    await expect(panel.getByRole('link', { name: 'Source', exact: true })).toHaveAttribute('href', href(source.sourceUrl));
    await expect(panel.getByRole('link', { name: source.license, exact: true })).toHaveAttribute('href', href(source.licenseUrl));
  });
}

test('native select keyboard activation updates the photo without losing focus', async ({ page }, info) => {
  await wire(page);
  await page.goto('/');
  const select = selectOf(page);
  await select.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(select).toBeFocused();
  await expect(select).toHaveValue('tata-punch-ev-lr-35');
  await expectLoadedImage(page, 'tata-punch-ev-lr-35', 'Tata Punch EV');
  await page.screenshot({ path: info.outputPath('vehicle-photo-keyboard.png') });
});

for (const id of ['tata-nexon-ev-lr-45', 'mg-windsor-ev-38']) {
  test(`${id} uses an honest fallback and keeps range review`, async ({ page }) => {
    await wire(page);
    await page.goto('/');
    const entry = VEHICLE_CATALOG.find(item => item.id === id)!;
    await selectOf(page).selectOption(id);
    await expect(imageOf(page)).toHaveCount(0);
    await expect(panelOf(page)).toContainText(`Photo unavailable for ${entry.make} ${entry.model}. No lookalike image is substituted.`);
    await expect(page.locator('#rw-range')).toBeVisible();
    await expect(page.locator('.warn-hint')).toContainText('Required');
  });
}

test('custom vehicle has no invented photo and keeps battery/range inputs', async ({ page }) => {
  await wire(page);
  await page.goto('/');
  await selectOf(page).selectOption('custom');
  await expect(imageOf(page)).toHaveCount(0);
  await expect(panelOf(page)).toHaveText('Your custom vehicle — no vehicle image is used.');
  await page.locator('#custom-kwh').fill('70');
  await page.locator('#custom-range').fill('350');
  await expect(page.locator('#custom-kwh')).toHaveValue('70');
  await expect(page.locator('#custom-range')).toHaveValue('350');
});

test('stale image errors cannot replace the current photo panel', async ({ page }) => {
  await wire(page);
  await page.goto('/');
  await expectLoadedImage(page, 'tata-harrier-ev-75', 'Tata Harrier EV');
  const oldImage = await imageOf(page).elementHandle();
  await selectOf(page).selectOption('mg-zs-ev-50');
  await expectLoadedImage(page, 'mg-zs-ev-50', 'MG ZS EV');
  await oldImage?.evaluate(el => el.dispatchEvent(new Event('error', { bubbles: true })));
  await expect(panelOf(page).locator('img.vehicle-photo-image')).toHaveCount(1);
  await expect(panelOf(page).locator('.vehicle-photo-fallback')).toHaveCount(0);
  await imageOf(page).evaluate(el => el.dispatchEvent(new Event('error', { bubbles: true })));
  await expect(panelOf(page).locator('.vehicle-photo-fallback')).toContainText('Photo unavailable for MG ZS EV. No lookalike image is substituted.');
});

for (const [width, height, maxHeight] of [[1280, 800, 168], [390, 844, 150]] as const) {
  test(`vehicle photo stays bounded at ${width}px`, async ({ page }, info) => {
    await wire(page);
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await expectLoadedImage(page, 'tata-harrier-ev-75', 'Tata Harrier EV');
    const metrics = await page.evaluate(() => {
      const image = document.querySelector('.vehicle-photo-image') as HTMLImageElement;
      const panel = document.querySelector('[data-vehicle-photo]') as HTMLElement;
      return { pageFits: document.body.scrollWidth <= window.innerWidth,
        panelFits: panel.scrollWidth <= panel.clientWidth + 1,
        imageHeight: image.getBoundingClientRect().height };
    });
    expect(metrics.pageFits).toBe(true);
    expect(metrics.panelFits).toBe(true);
    expect(metrics.imageHeight).toBeLessThanOrEqual(width === 1280 ? maxHeight + 0.001 : maxHeight);
    await page.screenshot({ path: info.outputPath(`vehicle-photo-${width}.png`) });
  });
}
