import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
writeFileSync("fixture-backend.pid", String(process.pid));
await import(pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/backend/dist/runtime/backend.js")).href);
