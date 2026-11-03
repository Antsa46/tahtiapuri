const info = { backend: "cpu", gpuLayers: 0, loadMs: 0, generationMs: 0, contextSize: 4096, engineVersion: "3.22.2", modelId: "qwen3-4b-q4-k-m" };
let session = "";
const timers = new Map<string, NodeJS.Timeout>();
const send = (id: unknown, text: string, error: string | null) => process.parentPort.postMessage({ type: "result", session, id, reply: { text, error, info } });
process.parentPort.on("message", ({ data }: { data: unknown }) => {
  if (!data || typeof data !== "object") return;
  const m = data as Record<string, unknown>;
  if (m.type === "initialize") { session = m.session as string; process.parentPort.postMessage({ type: "ready", session, info }); return; }
  if (m.session !== session) return;
  if (m.type === "run") {
    process.parentPort.postMessage({ type: "generating", session, id: m.id });
    const prompt = (m.input as { prompt: string }).prompt;
    if (!prompt.startsWith("hold:")) timers.set(m.id as string, setTimeout(() => send(m.id, prompt, null), 30));
  }
  if (m.type === "cancel") { clearTimeout(timers.get(m.id as string)); send(m.id, "", "CANCELLED"); }
  if (m.type === "shutdown") process.exit(0);
});
