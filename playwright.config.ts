import { defineConfig } from '@playwright/test';

// Local default: use the installed Google Chrome. In CI, install Playwright's
// Chromium and set PLAYWRIGHT_CHANNEL=bundled instead.
const useBundled = ['bundled', 'chromium'].includes(process.env.PLAYWRIGHT_CHANNEL ?? '');
const channel = (process.env.PLAYWRIGHT_CHANNEL ?? 'chrome') as 'chrome';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8799',
    ...(useBundled ? {} : { channel }),
    headless: true,
    viewport: { width: 1500, height: 1100 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx tsx tests/e2e/fixture-server.ts',
    url: 'http://127.0.0.1:8799/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
