// Closed original-handle regressions only. No application or native actors.
export default { test: { include: [
  "tests/support/mcp/native-host-observation.test.ts",
  "apps/desktop/src/main/native-development-resource-call.test.ts",
], exclude: ["**/node_modules/**", "**/dist/**"] } };
