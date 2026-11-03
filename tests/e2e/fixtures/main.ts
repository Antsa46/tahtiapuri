import { readFileSync } from "node:fs";
import { startDesktop } from "@tahtiapuri/desktop/bootstrap";
import { join } from "node:path";
const root = process.cwd();
const scenario = process.argv.at(-2);
const data = process.argv.at(-1)!;
const backendEntry = scenario === "sky-no-catalog" ? join(root, ".artifacts/tests/e2e-build/sky-no-catalog.js")
  : scenario === "early-exit" ? join(root, ".artifacts/tests/e2e-build/early-exit.js")
  : scenario === "unresponsive" ? join(root, ".artifacts/tests/e2e-build/unresponsive.js")
  : scenario === "unready-ui" ? join(root, ".artifacts/tests/e2e-build/recording-backend.js")
  : join(root, "apps/backend/dist/runtime/backend.js");
const approved = JSON.parse(readFileSync(join(root, "resources/models/qwen3-4b.json"), "utf8"));
const model = scenario?.startsWith("model") ? {
  entry: scenario === "model-echo" ? join(root, ".artifacts/tests/e2e-build/model-echo.js") : scenario === "model-helper-hold" ? join(root, ".artifacts/tests/e2e-build/helper-hold-model.js") : scenario === "model-oom" ? join(root, ".artifacts/tests/e2e-build/model-fault.js") : join(root, "apps/backend/dist/runtime/model-worker.js"),
  profile: { file: join(root, ".local/models", approved.file), bytes: approved.bytes,
    sha256: scenario === "model-invalid" ? "0".repeat(64) : approved.sha256, templateSha256: approved.expectedChatTemplateSha256 },
  cudaPaths: [join(root, ".local/toolchain/cuda/libcublas-windows-x86_64-13.2.0.9-archive/bin/x64"), join(root, ".local/toolchain/cuda/cuda_cudart-windows-x86_64-13.1.80-archive/bin/x64")],
} : undefined;
startDesktop({
  ...(model ? { model } : {}),
  backendEntry, data, renderer: join(root, "apps/web/dist"),
  preload: scenario === "probe" ? join(root, ".artifacts/tests/e2e-build/probe-preload.cjs")
    : scenario === "unready-ui" ? join(root, ".artifacts/tests/e2e-build/empty-preload.cjs")
    : join(root, "apps/desktop/dist/preload/index.cjs"),
});
