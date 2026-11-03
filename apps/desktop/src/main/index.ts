import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDesktop } from "./start-desktop.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const profile = JSON.parse(readFileSync(join(root, "resources/models/qwen3-4b.json"), "utf8"));
startDesktop({
  backendEntry: join(root, "apps/backend/dist/runtime/backend.js"),
  preload: join(root, "apps/desktop/dist/preload/index.cjs"),
  renderer: join(root, "apps/web/dist"),
  data: join(root, ".local/data/desktop"),
  model: { entry: join(root, "apps/backend/dist/runtime/model-worker.js"),
    profile: { file: join(root, ".local/models", profile.file), bytes: profile.bytes, sha256: profile.sha256, templateSha256: profile.expectedChatTemplateSha256 },
    cudaPaths: [join(root, ".local/toolchain/cuda/libcublas-windows-x86_64-13.2.0.9-archive/bin/x64"), join(root, ".local/toolchain/cuda/cuda_cudart-windows-x86_64-13.1.80-archive/bin/x64")] },
});
