import { rmSync } from "node:fs";
import path from "node:path";

import { defineConfig } from "playwright/test";

const e2eDataDirectory = path.resolve(".tmp/e2e-data");
rmSync(e2eDataDirectory, { recursive: true, force: true });

const projects = [];
for (const browserName of ["chromium", "webkit"]) {
  for (const viewport of [
    { width: 390, height: 844, label: "390" },
    { width: 768, height: 1024, label: "768" },
    { width: 1440, height: 1000, label: "1440" },
  ]) {
    projects.push({
      name: `${browserName}-${viewport.label}`,
      use: {
        browserName,
        viewport: { width: viewport.width, height: viewport.height },
      },
    });
  }
}

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: "http://127.0.0.1:3417",
    locale: "zh-CN",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects,
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:3417/api/auth/me",
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "3417",
      CAL1CARD_APP_PASSWORD: "e2e-console-password",
      CAL1CARD_DATA_DIR: e2eDataDirectory,
      CAL1CARD_PUBLIC_ORIGIN: "http://127.0.0.1:3417",
      CAL1CARD_WEB_LOGIN_ENABLED: "false",
    },
  },
});
