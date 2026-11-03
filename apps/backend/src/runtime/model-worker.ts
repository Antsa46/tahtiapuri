import { isModelInput, isJobId, isEngineInfo } from "@tahtiapuri/validation/assistant";
import { isSession } from "@tahtiapuri/validation/backend";
import { exactKeys, isRecord } from "@tahtiapuri/validation/public";
import { NativeEngine, nativeErrorCode } from "../modules/assistant/adapters/native-engine.js";
type ParentPort = { on(event: "message", callback: (event: { data: unknown }) => void): void; postMessage(message: unknown): void };
const port = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
if (!port) throw new Error("Model worker requires its owning Electron main.");
const engine = new NativeEngine();
let session: string | undefined;
let initializing = false, ready = false, stopping = false;
let current: { id: string; abort: AbortController } | undefined;
let lastParent = Date.now();
async function stop() {
  if (stopping) return; stopping = true; current?.abort.abort();
  await engine.dispose().catch(() => {}); process.exit(0);
}
port.on("message", event => {
  const message: unknown = event.data;
  if (!isRecord(message) || stopping) return;
  if (!session) {
    if (initializing || !exactKeys(message, ["type", "session", "profile", "backend"]) || message.type !== "initialize"
      || !isSession(message.session) || !isRecord(message.profile)
      || !exactKeys(message.profile, ["file", "bytes", "sha256", "templateSha256"])
      || typeof message.profile.file !== "string" || message.profile.file.length > 4096
      || message.profile.bytes !== 2497280256 || !isSession(message.profile.sha256) || !isSession(message.profile.templateSha256)
      || (message.backend !== "cpu" && message.backend !== "cuda")) return;
    initializing = true; session = message.session; lastParent = Date.now();
    const profile = { file: message.profile.file, bytes: message.profile.bytes, sha256: message.profile.sha256, templateSha256: message.profile.templateSha256 };
    void engine.initialize(profile, message.backend).then(info => {
      if (!stopping && isEngineInfo(info)) { ready = true; port.postMessage({ type: "ready", session, info }); }
    }).catch(async error => {
      port.postMessage({ type: "load-error", session, code: nativeErrorCode(error, false) });
      await stop();
    });
    return;
  }
  if (message.session !== session) return;
  if (exactKeys(message, ["type", "session"]) && message.type === "ping") { lastParent = Date.now(); return; }
  if (exactKeys(message, ["type", "session"]) && message.type === "shutdown") { lastParent = Date.now(); void stop(); return; }
  if (exactKeys(message, ["type", "session", "id"]) && message.type === "cancel" && isJobId(message.id)) {
    lastParent = Date.now(); if (current?.id === message.id) current.abort.abort(); return;
  }
  if (!ready || current || !exactKeys(message, ["type", "session", "id", "input"])
    || message.type !== "run" || !isJobId(message.id) || !isModelInput(message.input)) return;
  lastParent = Date.now();
  const id = message.id, abort = new AbortController(); current = { id, abort };
  void engine.generate(message.input.prompt, abort.signal, () => {
    if (!stopping) port.postMessage({ type: "generating", session, id });
  }).then(reply => {
    if (!stopping) port.postMessage({ type: "result", session, id, reply });
  }).finally(() => { current = undefined; });
});
setInterval(() => { if (Date.now() - lastParent > 10_000) void stop(); }, 1000);
