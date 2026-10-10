import { defineConfig } from "@playwright/test";

/**
 * Browser-based verification for the real-time workflows.
 *
 * Serves the production frontend build and runs it against a real backend with
 * the Socket.IO layer enabled (in-memory MongoDB), so what is exercised is the
 * same code path a user hits.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.js/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],

  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },

  webServer: [
    {
      command: "node e2e/server.cjs",
      url: "http://127.0.0.1:5000/api/health",
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "npm run build && npx vite preview --host 127.0.0.1 --port 4173 --strictPort",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});