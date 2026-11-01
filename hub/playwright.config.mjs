import { defineConfig } from '@playwright/test';

// PLAYWRIGHT_CHANNEL=chrome uses an installed Chrome. CI installs its own Chromium.
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 60000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4310',
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    trace: 'off',
    actionTimeout: 10000
  },
  webServer: { command: 'node scripts/dev.mjs', url: 'http://localhost:4310/healthz', reuseExistingServer: false, stdout: 'ignore' }
});
