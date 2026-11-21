import { expect, test } from '@playwright/test';

for (const health of ['pending', 'failed']) {
  test(`planning does not claim live provenance while health is ${health}`, async ({ page }) => {
    let releaseHealth!: () => void;
    const heldHealth = new Promise<void>((resolve) => { releaseHealth = resolve; });
    let releasePlan!: () => void;
    const heldPlan = new Promise<void>((resolve) => { releasePlan = resolve; });
    await page.route(/^https?:\/\//, async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
      else await route.abort();
    });
    await page.route('**/api/health', async (route) => {
      if (health === 'failed') await route.abort('failed');
      else { await heldHealth; await route.fulfill({ json: { ok: true, mock: true, ai: false, chargersSeen: 0 } }); }
    });
    await page.route('**/api/plan', async (route) => {
      const response = await route.fetch(); await heldPlan; await route.fulfill({ response });
    });
    await page.goto('/');
    for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
      await page.getByRole('combobox', { name, exact: true }).fill(query!);
      await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
    }
    await page.locator('.planner-go').click();
    try {
      await expect(page.locator('.planner-go')).toHaveText('Planning route…');
      await expect(page.locator('.plan-busy')).toBeHidden();
      await page.screenshot({ path: test.info().outputPath('unknown-mode.png') });
    } finally { releaseHealth(); releasePlan(); }
    await expect(page.locator('.plan-results')).toContainText('Synthetic data');
  });
}
