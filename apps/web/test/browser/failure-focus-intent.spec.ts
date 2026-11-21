import { expect, test } from '@playwright/test';

for (const mode of ['plan', 'ai']) {
  test(`${mode} failure keeps focus deliberately moved while waiting`, async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(/^https?:\/\//, async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') await route.continue();
      else await route.abort();
    });
    await page.route('**/api/health', (route) => route.fulfill({ json: { ok: true, mock: true, ai: true, chargersSeen: 0 } }));
    await page.route(mode === 'plan' ? '**/api/plan' : '**/api/ai/plan', async (route) => {
      await held;
      await route.fulfill({ status: 422, json: { code: 'not_determined', cause: 'budget-exhausted', error: 'Synthetic failure boundary.' } });
    });
    await page.goto('/');
    for (const [name, query] of [['From', 'Delhi'], ['To', 'Jaipur']]) {
      await page.getByRole('combobox', { name, exact: true }).fill(query!);
      await page.locator('.suggestions:not(.hidden) .suggestion-item').first().click();
    }
    const button = page.locator(mode === 'plan' ? '.planner-go' : '[data-ai-plan]');
    await button.click();
    await expect(button).toBeDisabled();
    await expect(page.locator('.planner-form')).toHaveAttribute('aria-busy', 'true');
    const field = page.getByRole('combobox', { name: 'From', exact: true });
    await field.focus();
    release();
    await expect(button).toBeEnabled();
    await expect(page.locator('.planner-form')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.error-box')).toBeVisible();
    await expect(field).toBeFocused();
    await field.fill('Updated origin');
    await expect(field).toHaveValue('Updated origin');
    await page.screenshot({ path: test.info().outputPath('failure-focus.png') });
  });
}
