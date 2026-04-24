import { defineConfig, devices } from "@playwright/test";

// Perf suite boots against a running local dev stack (API on 3009, web on 5180).
// reuseExistingServer keeps iteration fast: when a dev shell is already up, the
// suite attaches; otherwise playwright boots one from the repo root.
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "playwright-report/results.json" }],
  ],
  use: {
    baseURL: process.env.AIF_WEB_URL ?? "http://localhost:5180",
    trace: "retain-on-failure",
    video: "off",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
  },
  webServer: process.env.AIF_SKIP_DEV_SERVER
    ? undefined
    : {
        command: "npm run dev --prefix ../..",
        url: "http://localhost:5180",
        reuseExistingServer: true,
        timeout: 120_000,
        stdout: "pipe",
        stderr: "pipe",
      },
  projects: [
    {
      name: "chromium-cold",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
