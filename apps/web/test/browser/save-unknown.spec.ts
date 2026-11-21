import { expect, test } from '@playwright/test';

for (const [label, body] of [
  ['null JSON', 'null'],
  ['missing trip', '{"plan":{}}'],
  ['blank ID', '{"trip":{"id":"   "}}'],
  ['numeric ID', '{"trip":{"id":42}}'],
  ['malformed JSON', '{'],
] as const) {
  test(`unknown save identity: ${label}`, async ({ page }) => {
    await page.route(/^https?:\/\//, async route => { const host = new URL(route.request().url()).hostname; if (host === 'localhost' || host === '127.0.0.1') await route.continue(); else await route.abort(); });
    const plan = (await (await page.request.post('/api/plan', { data: { origin: { label: 'Delhi', lat: 28.6, lon: 77.2 }, destination: { label: 'Jaipur', lat: 26.9, lon: 75.8 } } })).json()).plan;
    let posts = 0;
    await page.route('**/api/plan', route => route.fulfill({ json: { plan } }));
    await page.route('**/api/geocode*', route => route.fulfill({ json: { hits: [{ name: 'Delhi', label: 'Delhi', lat: 28, lon: 77 }] } }));
    await page.route('**/api/trips', async route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { trips: [] } });
      posts += 1;
      return route.fulfill({ status: 201, contentType: 'application/json', body });
    });
    await page.goto('/');
    for (const name of ['From', 'To']) { await page.getByRole('combobox', { name, exact: true }).fill('Delhi'); await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click(); }
    await page.getByRole('button', { name: 'Plan route', exact: true }).click();
    const facts = () => page.locator('.plan-head, .trip-strip, .stops, [data-journey-briefing]').allInnerTexts();
    const before = await facts();
    const save = page.locator('[data-save]');
    await save.click();
    await expect(save).toHaveText('Save status unknown');
    await expect(save).toBeDisabled();
    expect(await save.getAttribute('data-saved-trip-id')).toBeNull();
    await expect(page.getByText('Saved to your trips')).toHaveCount(0);
    await expect(page.locator('#toast-root')).not.toContainText('Trip saved.');
    await expect(page.locator('[data-storage-warning]')).toHaveText('Save could not be confirmed. Check saved trips before trying again.');
    await expect(page.getByRole('button', { name: 'Check saved trips', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enable save retry', exact: true })).toBeVisible();
    expect(await facts()).toEqual(before);
    await save.evaluate(element => { for (let n = 0; n < 4; n += 1) element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(posts).toBe(1);
  });
}

test("unknown save recovers through drawer check and explicit retry", async ({ page }) => {
  await page.route(/^https?:\/\//, async route => { const host = new URL(route.request().url()).hostname; if (host === "localhost" || host === "127.0.0.1") await route.continue(); else await route.abort(); });
  const plan = (await (await page.request.post("/api/plan", { data: { origin: { label: "Delhi", lat: 28.6, lon: 77.2 }, destination: { label: "Jaipur", lat: 26.9, lon: 75.8 } } })).json()).plan;
  let posts = 0, gets = 0; const warning = 'Storage operation completed, but its writer lock could not be released. Do not retry the operation; stop all writers before manual recovery.';
  await page.route("**/api/plan", route => route.fulfill({ json: { plan } }));
  await page.route("**/api/geocode*", route => route.fulfill({ json: { hits: [{ name: "Delhi", label: "Delhi", lat: 28, lon: 77 }] } }));
  await page.route("**/api/trips", async route => { if (route.request().method() === "GET") { gets += 1; return route.fulfill({ json: { trips: [] } }); } posts += 1; if (posts === 1) return route.fulfill({ status: 201, contentType: "application/json", body: "null" }); return route.fulfill({ json: { trip: { id: "valid-saved" }, warnings: [warning], storage: { committed: true, lockReleased: false } } }); });
  await page.goto("/");
  for (const name of ["From", "To"]) { await page.getByRole("combobox", { name, exact: true }).fill("Delhi"); await page.locator(".suggestions:not(.hidden) .suggestion-item").first().click(); }
  await page.getByRole("button", { name: "Plan route", exact: true }).click();
  const facts = () => page.locator(".plan-head, .trip-strip, .stops, [data-journey-briefing]").allInnerTexts();
  const before = await facts(), save = page.locator("[data-save]"), original = await save.innerText();
  await save.click(); await expect(save).toHaveText("Save status unknown"); await expect(save).toBeDisabled(); expect(posts).toBe(1);
  const banner = page.locator("[data-storage-warning]"); await expect(banner).toHaveText("Save could not be confirmed. Check saved trips before trying again.");
  const check = page.getByRole("button", { name: "Check saved trips", exact: true }), retry = page.getByRole("button", { name: "Enable save retry", exact: true });
  await expect(check).toBeVisible(); await expect(retry).toBeVisible(); expect(await facts()).toEqual(before);
  await check.click(); await expect(page.locator("#trips-drawer")).toBeVisible(); await expect(page.locator("#trips-button")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".trip-row")).toHaveCount(0); await expect.poll(() => gets).toBe(1); await expect(page.locator('[data-trip-result-count]')).toHaveText('Showing 0 of 0 saved trips.'); expect(posts).toBe(1); expect(await facts()).toEqual(before);
  await page.locator("#trips-drawer [data-close]").click(); await expect(page.locator("#trips-drawer")).toBeHidden(); await retry.click();
  await expect(banner).toHaveCount(0); await expect(check).toHaveCount(0); await expect(retry).toHaveCount(0);
  await expect(save).toBeEnabled(); await expect(save).toHaveText(original); expect(posts).toBe(1); expect(await facts()).toEqual(before);
  await save.click(); await expect.poll(() => posts).toBe(2); await expect(save).toBeDisabled(); await expect(save).toHaveText("Saved to your trips");
  expect(await save.getAttribute("data-saved-trip-id")).toBe("valid-saved");
  await expect(banner).toHaveCount(1); await expect(banner).toContainText("Trip saved."); await expect(banner).toContainText(warning); expect(await facts()).toEqual(before);
});
