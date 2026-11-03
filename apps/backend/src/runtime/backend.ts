import { ParentModelEngine } from "../modules/assistant/adapters/parent-model-engine.js";
import { AssistantService } from "../modules/assistant/application/assistant-service.js";
import { isInitialize } from "@tahtiapuri/validation/backend";
import { createBackend } from "../composition/create-backend.js";
type ParentPort = {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
};
const port = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
if (!port) throw new Error("Backend requires its owning Electron process.");
let lastParentMessage = Date.now();
const engine = new ParentModelEngine(message => port.postMessage(message));
const assistant = new AssistantService(engine);
const endpoint = createBackend({
  send: message => port.postMessage(message),
  assistant,
  stop: () => { assistant.dispose(); setImmediate(() => process.exit(0)); },
  now: () => Date.now(),
});
port.on("message", event => {
  if (engine.receive(event.data)) { lastParentMessage = Date.now(); return; }
  if (endpoint.receive(event.data)) {
    if (isInitialize(event.data)) engine.initialize(event.data.session);
    lastParentMessage = Date.now();
  }
});
// Also bounds the child's lifetime if its owner disappears before a graceful stop.
setInterval(() => {
  if (Date.now() - lastParentMessage > 10_000) process.exit(1);
}, 1000);
