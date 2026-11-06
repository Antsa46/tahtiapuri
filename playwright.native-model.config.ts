import { defineConfig } from "@playwright/test";
import { join } from "node:path";
const runId = process.env.TAHTIAPURI_NATIVE_E2E_RUN;
if (!runId || !/^[a-f0-9]{32}$/.test(runId)) throw new Error("Use the bounded native desktop launcher.");
const runRoot = join(".artifacts/tests/native-desktop/runs", runId);
export default defineConfig({
  testDir: "./tests/e2e/desktop", testMatch: ["**/native-model.spec.ts", "**/native-backend-model.spec.ts"], workers: 1, retries: 0, timeout: 210_000,
  outputDir: join(runRoot, "output"),
  reporter: [["list"], ["json", { outputFile: join(runRoot, "report.json") }]],
});
