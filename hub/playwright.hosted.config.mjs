import { defineConfig } from '@playwright/test';
const origin = process.env.HUB_HOSTED_TEST_ORIGIN;
if (origin !== 'https://hub-preview.crumbyte.com' || process.env.HUB_HOSTED_TEST_APPROVED !== origin) {
  throw new Error('Hosted tests require explicit approval for https://hub-preview.crumbyte.com');
}
export default defineConfig({ testDir: '.', testMatch: process.env.HUB_HOSTED_MUTATIONS_APPROVED===origin ? ['hosted/*.spec.mjs','e2e/hub.spec.mjs'] : ['hosted/*.spec.mjs'], workers: 1, retries: 0, timeout: 60000,
  outputDir: '/tmp/hub-hosted-test-results', reporter: [['list']],
  use: { baseURL: origin, trace: 'off', screenshot: 'off', video: 'off' } });
