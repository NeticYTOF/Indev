import { expect, test } from '@playwright/test';

test('deleting the same saved trip allows the displayed plan to be saved again', async ({ page }) => {
  await page.route(/^https?:\/\//, async route => { const host = new URL(route.request().url()).hostname; if (host === 'localhost' || host === '127.0.0.1') await route.continue(); else await route.abort(); });
  const planResponse = await page.request.post('/api/plan', { data: { origin: { label: 'Delhi', lat: 28.6, lon: 77.2 }, destination: { label: 'Jaipur', lat: 26.9, lon: 75.8 } } });
  const plan = (await planResponse.json()).plan;
  let saved: unknown = null, posts: unknown[] = [];
  await page.route('**/api/plan', route => route.fulfill({ json: { plan } }));
  await page.route('**/api/geocode*', route => route.fulfill({ json: { hits: [{ name: 'Delhi', label: 'Delhi', lat: 28, lon: 77 }] } }));
  await page.route('**/api/trips', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { trips: saved ? [saved] : [] } });
    const post = route.request().postDataJSON() as { plan: Record<string, unknown> & { id: string } };
    posts.push(post); saved = { ...post.plan, name: 'Fixture', stations: [] };
    return route.fulfill({ json: { trip: saved } });
  });
  await page.route(`**/api/trips/${plan.id}`, route => { expect(route.request().method()).toBe('DELETE'); saved = null; return route.fulfill({ json: { ok: true } }); });
  await page.goto('/');
  for (const name of ['From', 'To']) {
    await page.getByRole('combobox', { name, exact: true }).fill('Delhi');
    await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
  }
  await page.getByRole('button', { name: 'Plan route', exact: true }).click();
  const save = page.locator('[data-save]'), facts = await page.locator('.plan-results').innerText();
  const initial = await save.innerText();
  await save.click();
  await expect(save).toBeDisabled();
  await expect(save).toHaveText('Saved to your trips');
  await page.locator('#trips-button').click(); await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.trip-row')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(save).toBeEnabled(); await expect(save).toHaveText(initial);
  expect(await page.locator('.plan-results').innerText()).toBe(facts);
  await save.click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toEqual(posts[0]);
});

test("unrelated or failed DELETE does not reset the saved plan state", async ({ page }) => {
  await page.route(/^https?:\/\//, async route => { const host = new URL(route.request().url()).hostname; if (host === "localhost" || host === "127.0.0.1") await route.continue(); else await route.abort(); });
  const plan = (await (await page.request.post("/api/plan", { data: { origin: { label: "Delhi", lat: 28.6, lon: 77.2 }, destination: { label: "Jaipur", lat: 26.9, lon: 75.8 } } })).json()).plan;
  const saved: { current: Record<string, unknown> | null } = { current: null }; let removedB = false; const deletes: Record<string, number> = {};
  await page.route("**/api/plan", route => route.fulfill({ json: { plan } }));
  await page.route("**/api/geocode*", route => route.fulfill({ json: { hits: [{ name: "Delhi", label: "Delhi", lat: 28, lon: 77 }] } }));
  await page.route("**/api/trips", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { trips: saved.current ? [saved.current, ...(removedB ? [] : [{ ...saved.current, id: "unrelated-b", name: "Saved B" }])] : [] } });
    const post = route.request().postDataJSON() as { plan: Record<string, unknown> }; saved.current = { ...post.plan, name: "Saved A", stations: [] }; return route.fulfill({ json: { trip: saved.current } });
  });
  await page.route("**/api/trips/*", async route => {
    expect(route.request().method()).toBe("DELETE");
    const id = new URL(route.request().url()).pathname.split("/").at(-1) ?? ""; deletes[id] = (deletes[id] ?? 0) + 1;
    if (id === saved.current?.id) return route.fulfill({ status: 503, json: { error: "Synthetic delete failure" } });
    removedB = true; return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  for (const name of ["From", "To"]) {
    await page.getByRole("combobox", { name, exact: true }).fill("Delhi");
    await page.locator(".suggestions:not(.hidden) .suggestion-item").first().click();
  }
  await page.getByRole("button", { name: "Plan route", exact: true }).click();
  const save = page.locator("[data-save]");
  await save.click(); await expect(save).toHaveText("Saved to your trips"); await expect(save).toBeDisabled();
  await page.locator("#trips-button").click(); await expect(page.locator(".trip-row")).toHaveCount(2);
  await page.locator(".trip-row").filter({ hasText: "Saved B" }).getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(() => deletes["unrelated-b"]).toBe(1); await expect(page.locator(".trip-row")).toHaveCount(1);
  await expect(save).toHaveText("Saved to your trips"); await expect(save).toBeDisabled();
  const savedId = String(saved.current?.id ?? "");
  await page.locator(".trip-row").filter({ hasText: "Saved A" }).getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(() => deletes[savedId]).toBe(1);
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeEnabled();
  await expect(page.locator(".trip-row")).toHaveCount(1); await expect(save).toHaveText("Saved to your trips"); await expect(save).toBeDisabled();
});

test("late DELETE of an old saved trip does not mutate a newer plan result", async ({ page }) => {
  await page.route(/^https?:\/\//, async route => { const host = new URL(route.request().url()).hostname; if (host === "localhost" || host === "127.0.0.1") await route.continue(); else await route.abort(); });
  const source = (await (await page.request.post("/api/plan", { data: { origin: { label: "Delhi", lat: 28.6, lon: 77.2 }, destination: { label: "Jaipur", lat: 26.9, lon: 75.8 } } })).json()).plan;
  const planA = source, planB = { ...source, id: source.id + "-later" };
  let release!: () => void; let planCalls = 0, getCount = 0, deleteA = 0; const held = new Promise<void>(resolve => { release = resolve; }); const stored: Record<string, unknown>[] = [];
  await page.route("**/api/plan", route => route.fulfill({ json: { plan: planCalls++ ? planB : planA } }));
  await page.route("**/api/geocode*", route => route.fulfill({ json: { hits: [{ name: "Delhi", label: "Delhi", lat: 28, lon: 77 }] } }));
  await page.route("**/api/trips", async route => { if (route.request().method() === "GET") { getCount += 1; return route.fulfill({ json: { trips: stored } }); } const post = route.request().postDataJSON() as { plan: Record<string, unknown> }; stored.push({ ...post.plan, name: "Fixture", stations: [] }); return route.fulfill({ json: { trip: stored.at(-1) } }); });
  await page.route("**/api/trips/" + planA.id, async route => { expect(route.request().method()).toBe("DELETE"); deleteA += 1; await held; const at = stored.findIndex(t => t.id === planA.id); if (at >= 0) stored.splice(at, 1); return route.fulfill({ json: { ok: true } }); });
  await page.goto("/");
  for (const name of ["From", "To"]) { await page.getByRole("combobox", { name, exact: true }).fill("Delhi"); await page.locator(".suggestions:not(.hidden) .suggestion-item").first().click(); }
  await page.getByRole("button", { name: "Plan route", exact: true }).click();
  const save = page.locator("[data-save]");
  await expect(save).toHaveText("Trip is not saved yet — click to save");
  await save.click(); await expect(save).toHaveText("Saved to your trips");
  const oldButton = (await save.elementHandle())!;
  await page.locator("#trips-button").click(); await page.locator(".trip-row").filter({ hasText: "Fixture" }).getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(() => deleteA).toBe(1);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Plan route", exact: true }).click(); await expect.poll(() => planCalls).toBe(2);
  const currentSave = page.locator("[data-save]"); await expect(currentSave).toHaveText("Trip is not saved yet — click to save");
  await currentSave.click(); await expect(currentSave).toHaveText("Saved to your trips");
  const facts = await page.locator(".plan-results").innerText(), stamp = await currentSave.getAttribute("data-saved-trip-id");
  expect(stamp).toBe(planB.id); expect(stamp).not.toBe(planA.id);
  const getsBefore = getCount, refreshed = page.waitForResponse(r => r.url().endsWith("/api/trips") && r.request().method() === "GET"); release();
  expect((await (await refreshed).json()).trips.map((t: { id: string }) => t.id)).toEqual([planB.id]);
  expect(await page.locator(".plan-results").innerText()).toBe(facts);
  await expect(currentSave).toBeDisabled(); await expect(currentSave).toHaveText("Saved to your trips");
  expect(await currentSave.getAttribute("data-saved-trip-id")).toBe(planB.id);
  expect(await oldButton.evaluate(el => el.isConnected)).toBe(false);
  expect(getCount).toBe(getsBefore + 1);
});
