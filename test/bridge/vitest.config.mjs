import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./global-setup.mjs",
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
