import { defineConfig } from '@playwright/test';

/**
 * Browser regressions (written on the dev laptop; RUN on Linux - no
 * browser infra executes here).
 *
 * Requires the MOCK dev stack serving the web app on
 * http://localhost:5173 (npm run dev:stack - mock-gated, INDEV_MOCK=1).
 * The specs intercept the plan endpoint with SYNTHETIC 422 payloads;
 * no live provider is ever touched and no result here is a verdict
 * about live data.
 *
 * One-time provisioning (kept OUT of package.json deliberately so npm
 * ci/lock stay untouched by blind dependency edits):
 *   npm i -D @playwright/test && npx playwright install chromium
 */
export default defineConfig({
  testDir: './apps/web/test/browser',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  use: { baseURL: 'http://localhost:5173' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
