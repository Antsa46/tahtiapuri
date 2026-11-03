import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e/desktop", workers: 1, retries: 0, timeout: 30_000,
  outputDir: ".artifacts/tests/e2e",
  reporter: [["list"], ["json", { outputFile: ".artifacts/tests/e2e.json" }]],
});
