import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  // Each test with its time, on CI too
  reporter: 'list',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: { channel: 'chrome', headless: true, acceptDownloads: true },
})
