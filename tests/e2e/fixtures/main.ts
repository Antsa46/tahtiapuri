import { startDesktop } from "@tahtiapuri/desktop/bootstrap";
import { join } from "node:path";
const root = process.cwd();
const scenario = process.argv.at(-2);
const data = process.argv.at(-1)!;
const backendEntry = scenario === "early-exit" ? join(root, ".artifacts/tests/e2e-build/early-exit.js")
  : scenario === "unresponsive" ? join(root, ".artifacts/tests/e2e-build/unresponsive.js")
  : scenario === "unready-ui" ? join(root, ".artifacts/tests/e2e-build/recording-backend.js")
  : join(root, "apps/backend/dist/runtime/backend.js");
startDesktop({
  backendEntry, data, renderer: join(root, "apps/web/dist"),
  preload: scenario === "probe" ? join(root, ".artifacts/tests/e2e-build/probe-preload.cjs")
    : scenario === "unready-ui" ? join(root, ".artifacts/tests/e2e-build/empty-preload.cjs")
    : join(root, "apps/desktop/dist/preload/index.cjs"),
});
