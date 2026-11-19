import { defineConfig } from '@playwright/test';

// Own credential-free, synthetic-gated stack. Never reuse an unknown server.
// Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH only to use an existing local Chrome.
export default defineConfig({
  testDir: './apps/web/test/browser',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5174',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/ui-verify.mjs',
    url: 'http://localhost:5174',
    reuseExistingServer: false,
    timeout: 45_000,
    env: { UIV_SERVER_PORT: '8788', UIV_WEB_PORT: '5174' },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
