import { NativeEngine, nativeErrorCode } from "../modules/assistant/adapters/native-engine.js";
import { ModelWorkerCore } from "./model-worker-core.js";
type ParentPort = { on(event: "message", callback: (event: { data: unknown }) => void): void; postMessage(message: unknown): void };
const port = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
if (!port) throw new Error("Model worker requires its owning Electron main.");
const core = new ModelWorkerCore(new NativeEngine(), message => port.postMessage(message), code => {
  clearInterval(heartbeat); process.exit(code);
}, nativeErrorCode);
port.on("message", event => core.receive(event.data));
const heartbeat = setInterval(() => core.checkParent(), 1000);
