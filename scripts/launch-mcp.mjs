import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Discard host credentials and runtime injection before loading the adapter.
const allowed = new Set(["SYSTEMROOT", "WINDIR", "TEMP", "TMP"]);
for (const key of Object.keys(process.env)) if (!allowed.has(key.toUpperCase())) delete process.env[key];
const { startMcp } = await import("../apps/mcp/dist/server.js");
await startMcp(join(root, ".local/data/desktop/mcp/connection.json"));
