import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e/desktop", testMatch: "**/model.spec.ts", workers: 1, retries: 0, timeout: 180_000,
  outputDir: ".artifacts/tests/model",
  reporter: [["list"], ["json", { outputFile: ".artifacts/tests/model.json" }]],
});
