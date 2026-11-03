import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const { createBackend } = await import(pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/backend/dist/composition/create-backend.js")).href);
const { createObserving } = await import(pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/backend/dist/composition/create-observing.js")).href);
const port = (process as NodeJS.Process & { parentPort: { postMessage(m: unknown): void; on(event: "message", listener: (event: { data: unknown }) => void): void } }).parentPort;
const endpoint = createBackend({ observing: createObserving(process.cwd()), send: (m: unknown) => port.postMessage(m), stop: () => process.exit(0), now: () => Date.now() });
port.on("message", event => { endpoint.receive(event.data); });
