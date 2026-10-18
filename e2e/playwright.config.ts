import { defineConfig, devices } from "@playwright/test";

// Workers inherit this, so every file names its zones with the same run ID
process.env.E2E_RUN ??= Date.now().toString(36);

export default defineConfig({
  outputDir: "test-results",
  timeout: 300_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  retries: 0,
  reporter: "list",
  projects: [
    { name: "deploy", testMatch: "deploy.setup.ts", teardown: "lifecycle" },
    {
      name: "sites",
      testMatch: "*.e2e.ts",
      dependencies: ["deploy"],
      use: { ...devices["Desktop Chrome"] },
    },
    { name: "lifecycle", testMatch: "lifecycle.teardown.ts" },
  ],
});
