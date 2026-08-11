import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 960, height: 540 },
    deviceScaleFactor: 1,
    screenshot: 'only-on-failure'
  }
});
