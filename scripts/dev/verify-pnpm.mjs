import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
const tools = JSON.parse(readFileSync(join(root, "scripts/dev/toolchain.json"), "utf8"));
const base = join(root, ".local/toolchain/pnpm");
const lock = JSON.parse(readFileSync(join(base, "package-lock.json"), "utf8"));
const installed = JSON.parse(readFileSync(join(base, "node_modules/pnpm/package.json"), "utf8"));
if (lock.packages["node_modules/pnpm"]?.integrity !== tools.pnpm.integrity || installed.version !== tools.pnpm.version)
  throw new Error("pnpm does not match the pinned publication.");
