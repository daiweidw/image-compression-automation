import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:43128",
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "pnpm start",
    url: "http://127.0.0.1:43128/api/health",
    reuseExistingServer: false,
    env: {
      NODE_ENV: "production",
      PORT: "43128",
      IMAGE_COMPRESSION_APP_DATA_DIR: "/tmp/ica-e2e-app-data"
    }
  }
});
