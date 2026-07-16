import { defineConfig, devices } from "@playwright/test";

const mobileTests = /mobile\.spec\.ts/u;

export default defineConfig({
  testDir: "tests/browser",
  outputDir: "test-results",
  fullyParallel: false,
  forbidOnly: true,
  // Linux Firefox can occasionally stall at the browser/context boundary. A
  // single clean-context retry keeps CI sensitive to persistent regressions.
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    serviceWorkers: "allow",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      testIgnore: mobileTests,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      testIgnore: mobileTests,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      testIgnore: mobileTests,
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "android",
      testMatch: mobileTests,
      use: { ...devices["Pixel 5"] },
    },
    {
      name: "android-narrow",
      testMatch: mobileTests,
      use: {
        ...devices["Pixel 5"],
        viewport: { width: 320, height: 568 },
      },
    },
    {
      name: "ios",
      testMatch: mobileTests,
      use: { ...devices["iPhone 14"] },
    },
  ],
  webServer: {
    command: "npm run build && npm run serve:dist",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 120_000
  }
});
