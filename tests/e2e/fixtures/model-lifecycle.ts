import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { appendFile, readFile } from "node:fs/promises";
import type { EngineInfo, EngineReply } from "@tahtiapuri/validation/assistant";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { ModelWorkerCore } = await import(pathToFileURL(resolve(root, "apps/backend/dist/runtime/model-worker-core.js")).href);
const info: EngineInfo = { backend: "cpu", gpuLayers: 0, loadMs: 0, generationMs: 0, contextSize: 4096, engineVersion: "3.22.2", modelId: "qwen3-4b-q4-k-m" };
const record = (event: string) => appendFile("synthetic-worker-events.jsonl", JSON.stringify({ event, pid: process.pid }) + "\n");
const core = new ModelWorkerCore({
  async initialize() {
    const previous = await readFile("synthetic-worker-events.jsonl", "utf8").catch(error => {
      if (error.code === "ENOENT") return ""; throw error;
    });
    if (previous) {
      const last = JSON.parse(previous.trim().split("\n").at(-1)!);
      if (last.event !== "dispose" || !Number.isSafeInteger(last.pid) || last.pid <= 0) throw new Error("Invalid synthetic predecessor");
      let gone = false;
      try { process.kill(last.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") gone = true; else throw error; }
      if (!gone) throw new Error("Predecessor still alive at replacement initialization");
      await record("previous-exited");
    }
    await record("initialize"); return info;
  },
  async generate(prompt: string, _signal: AbortSignal, progress: () => void): Promise<EngineReply> {
    progress();
    if (prompt === "synthetic fatal disposal") {
      await new Promise(resolve => setTimeout(resolve, 1000));
      throw new Error("Synthetic unexpected native rejection");
    }
    return { text: prompt, error: null, info };
  },
  async dispose() { await record("dispose"); },
}, (message: unknown) => process.parentPort.postMessage(message), (code: number) => {
  clearInterval(heartbeat); process.exit(code);
}, (_error: unknown, cancelled: boolean) => cancelled ? "CANCELLED" : "ENGINE_UNAVAILABLE");
process.parentPort.on("message", ({ data }: { data: unknown }) => core.receive(data));
const heartbeat = setInterval(() => core.checkParent(), 1000);
