// Closed Host port/ledger/factory/package guard selection. Application actor
// execution is mocked; controller fixtures use actual Node files/local pipes.
export default {
  test: {
    include: [
      "tests/integration/mcp/native-host.integration.test.ts",
      "apps/desktop/src/main/native-development-resource-call.test.ts",
      "apps/desktop/src/main/native-launch-mcp-resources.test.ts",
      "apps/desktop/src/main/native-mcp-helpers.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
};
