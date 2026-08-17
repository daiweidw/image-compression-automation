import { defineConfig } from "@playwright/test";
import path from "node:path";

const executablePath = process.env.PLAYWRIGHT_CHROME_EXECUTABLE;
const runDirectory = path.resolve(process.env.ICA_TEST_RUN_DIR ?? ".ica-test/runs/web");

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 30_000,
  outputDir: path.join(runDirectory, "artifacts"),
  use: {
    baseURL: "http://127.0.0.1:43128",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ...(executablePath ? { launchOptions: { executablePath } } : {})
  },
  webServer: {
    command: "pnpm start",
    url: "http://127.0.0.1:43128/api/health",
    reuseExistingServer: false,
    env: {
      NODE_ENV: "production",
      PORT: "43128",
      IMAGE_COMPRESSION_APP_DATA_DIR: path.join(runDirectory, "app-data")
    }
  }
});
