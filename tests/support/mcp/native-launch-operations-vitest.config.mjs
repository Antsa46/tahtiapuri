// Closed mock selection for the semantic bridge and its existing launch owner.
export default {
  test: {
    include: [
      "apps/desktop/src/main/native-launch-gate.test.ts",
      "apps/desktop/src/main/native-launch-supervisor.test.ts",
      "apps/desktop/src/main/native-launch-worker-core.test.ts",
      "apps/desktop/src/main/native-launch-worker-config.test.ts",
      "apps/desktop/src/main/native-launch-worker-port.test.ts",
      "tests/support/mcp/native-launch-observation.test.mjs",
      "apps/desktop/src/main/native-main-identity-codec.test.ts",
      "apps/desktop/src/main/native-launch-operations.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
};
