// Closed connection/admission clock regressions. No application actors or IO.
export default {
  test: {
    include: [
      "apps/desktop/src/main/native-main-connection.test.ts",
      "apps/desktop/src/main/native-development-admission.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
};
