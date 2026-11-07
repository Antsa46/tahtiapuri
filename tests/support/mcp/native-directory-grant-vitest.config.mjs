// Closed directory/Host/resource regressions. Actor launches are mocked; Node file fixtures/local pipes are real.
export default {
  "test": {
    "include": [
      "apps/desktop/src/main/native-launch-gate.test.ts",
      "apps/desktop/src/main/native-launch-supervisor.test.ts",
      "apps/desktop/src/main/native-launch-worker-core.test.ts",
      "apps/desktop/src/main/native-launch-worker-config.test.ts",
      "apps/desktop/src/main/native-launch-worker-port.test.ts",
      "tests/support/mcp/native-launch-observation.test.mjs",
      "apps/desktop/src/main/native-main-identity-codec.test.ts",
      "apps/desktop/src/main/native-launch-operations.test.ts",
      "apps/desktop/src/main/native-launch-resource-owner.test.ts",
      "apps/desktop/src/main/native-launch-mcp-resources.test.ts",
      "apps/desktop/src/main/native-mcp-resources.test.ts",
      "tests/integration/mcp/native-host.integration.test.ts",
      "apps/desktop/src/main/native-development-resource-call.test.ts",
      "apps/desktop/src/main/native-mcp-helpers.test.ts"
    ],
    "exclude": [
      "**/node_modules/**",
      "**/dist/**"
    ]
  }
};
