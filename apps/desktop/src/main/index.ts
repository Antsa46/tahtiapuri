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
  model: { kind: "native-cpu", runtimeRoot: join(root, ".local/native/tahtiapuri-model"),
    workRoot: join(root, ".local/data/desktop/native-model"),
    profile: { file: join(root, ".local/models", profile.file), bytes: profile.bytes, sha256: profile.sha256, templateSha256: profile.expectedChatTemplateSha256 } },
});
