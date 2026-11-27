import { defineConfig, devices } from "@playwright/test";

const PORT = 3848;

// Smoke tests run against the production build (`npm run build` first) in
// sample mode, so they need no Google or Cloudflare credentials.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Lets a machine with a preinstalled Chromium skip `playwright install`.
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
          : {},
      },
    },
  ],
  webServer: {
    command: `node node_modules/next/dist/bin/next start -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/api/pages`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      CLOUDFLARE_API_TOKEN: "",
      CLOUDFLARE_ACCOUNT_ID: "",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
