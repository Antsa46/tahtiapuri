import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDesktop } from "./start-desktop.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
startDesktop({
  backendEntry: join(root, "apps/backend/dist/runtime/backend.js"),
  preload: join(root, "apps/desktop/dist/preload/index.cjs"),
  renderer: join(root, "apps/web/dist"),
  data: join(root, ".local/data/desktop"),
});
