import { expect, test } from '@playwright/test';

for (const moved of [false, true]) {
  test(`delete completion ${moved ? 'preserves deliberate planner focus' : 'restores normal drawer context'}`, async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let deleted = false;
    await page.route(/^https?:\/\//, async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
      else await route.abort();
    });
    await page.route('**/api/trips', (route) => route.fulfill({ json: { trips: deleted ? [] : [{
      id: 'fixture', name: 'Fixture', origin: { label: 'Delhi' }, destination: { label: 'Jaipur' },
      routeDistanceKm: 285, stations: [], totals: { totalTimeMin: 200 },
    }] } }));
    await page.route('**/api/trips/fixture', async (route) => {
      expect(route.request().method()).toBe('DELETE');
      await held; deleted = true; await route.fulfill({ json: { ok: true } });
    });
    await page.goto('/');
    await page.locator('#trips-button').click();
    const button = page.getByRole('button', { name: 'Delete', exact: true });
    await button.click();
    await expect(button).toBeDisabled();
    const field = page.getByRole('combobox', { name: 'From', exact: true });
    if (moved) {
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await field.focus();
    }
    release();
    await expect(page.locator('.trip-row')).toHaveCount(0);
    if (moved) {
      await expect(field).toBeFocused();
      await expect(page.locator('#trips-drawer')).toBeHidden();
    } else await expect(page.locator('#trips-button')).toBeFocused();
  });
}

test("held DELETE in reopened drawer preserves live search focus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let deleted = false, deleteSeen = false, reads = 0;
  await page.route(/^https?:\/\//, async route => { const host = new URL(route.request().url()).hostname; if (host === "localhost" || host === "127.0.0.1") await route.continue(); else await route.abort(); });
  await page.route("**/api/trips", route => {
    if (route.request().method() !== "GET") return route.continue();
    reads += 1;
    return route.fulfill({ json: { trips: deleted ? [] : [{ id: "fixture", name: "Fixture", origin: { label: "Delhi" }, destination: { label: "Jaipur" }, routeDistanceKm: 285, stations: [], totals: { totalTimeMin: 200 } }] } });
  });
  await page.route("**/api/trips/fixture", async route => {
    expect(route.request().method()).toBe("DELETE");
    deleteSeen = true; await held; deleted = true; await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/"); await page.locator("#trips-button").click();
  const button = page.getByRole("button", { name: "Delete", exact: true });
  await button.click();
  await expect.poll(() => deleteSeen).toBe(true); await expect(button).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(page.locator("#trips-drawer")).toBeHidden();
  await page.locator("#trips-button").click();
  const search = page.locator("[data-trip-search]"); await expect(search).toBeEnabled();
  await search.focus(); await search.fill("Fixture");
  const beforeRefresh = reads; await release();
  await expect.poll(() => reads).toBe(beforeRefresh + 1);
  await expect(page.locator(".trip-row")).toHaveCount(0);
  await expect(search).toHaveValue("Fixture"); await expect(search).toBeFocused(); await expect(page.locator("#trips-drawer")).toBeVisible();
});
