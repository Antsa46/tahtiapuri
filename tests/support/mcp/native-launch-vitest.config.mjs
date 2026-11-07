// Closed six-file mock suite. No native activation or application runtime.
export default {
  test: {
    include: [
      "apps/desktop/src/main/native-launch-gate.test.ts",
      "apps/desktop/src/main/native-launch-supervisor.test.ts",
      "apps/desktop/src/main/native-launch-worker-core.test.ts",
      "apps/desktop/src/main/native-launch-worker-config.test.ts",
      "apps/desktop/src/main/native-launch-worker-port.test.ts",
      "tests/support/mcp/native-launch-observation.test.mjs",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
};
