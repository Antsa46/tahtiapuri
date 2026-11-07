import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts", "apps/**/*.test.ts", "tests/integration/**/*.test.ts",
      "tests/evaluations/**/*.test.ts", "tests/support/mcp/native-host-observation.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    reporters: ["default", "json"],
    outputFile: ".artifacts/tests/unit.json",
  },
});
