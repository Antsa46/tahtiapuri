const info = { backend: "cpu", gpuLayers: 0, loadMs: 0, generationMs: 0, contextSize: 4096, engineVersion: "3.22.2", modelId: "qwen3-4b-q4-k-m" };
const sessionState = { session: "" };
process.parentPort.on("message", ({ data }: { data: unknown }) => {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const message = data as Record<string, unknown>;
  if (message.type === "initialize") { sessionState.session = message.session as string; process.parentPort.postMessage({ type: "ready", session: message.session, info }); }
  if (message.session !== sessionState.session) return;
  if (message.type === "run") process.parentPort.postMessage({ type: "result", session: message.session, id: message.id, reply: { text: "", error: "OUT_OF_MEMORY", info } });
  if (message.type === "shutdown") process.exit(0);
});
