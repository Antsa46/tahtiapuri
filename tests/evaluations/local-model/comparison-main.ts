import { app, utilityProcess } from "electron";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cpus, totalmem, release } from "node:os";
import { inputs, sha } from "./inputs.js";
import { assessDecision } from "./decision.js";
const root = process.cwd(), mode = process.argv.at(-1) === "smoke" ? "smoke" : "full";
const runId = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
const directory = join(root, ".artifacts/tests/evaluations/local-model", runId);
const data = join(root, ".local/pilot/electron");
mkdirSync(directory, { recursive: true }); mkdirSync(data, { recursive: true }); app.setPath("userData", data);
const source = inputs(root);
let git: string | null = null;
try {
  const head = readFileSync(join(root, ".git/HEAD"), "utf8").trim();
  git = head.startsWith("ref: ") ? readFileSync(join(root, ".git", head.slice(5)), "utf8").trim() : head;
} catch { /* A source archive can run the test; missing Git identity stays explicit. */ }

const smi = join(process.env.SystemRoot!, "System32/nvidia-smi.exe");
const gpu: { at: number; usedMiB: number }[] = [];
let gpuReason: string | null = null;
let smiInfo: string | null = null;
let monitor: ReturnType<typeof spawn> | undefined;
function startMonitor() {
try { smiInfo = execFileSync(smi, ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits", "-i", "0"], { encoding: "utf8", timeout: 5000 }).trim(); }
catch { gpuReason = "nvidia-smi not available"; }
monitor = gpuReason ? undefined : spawn(smi, ["--query-gpu=memory.used", "--format=csv,noheader,nounits", "-i", "0", "-lms", "250"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let pending = "";
monitor?.stdout?.on("data", chunk => {
  pending += String(chunk); const lines = pending.split(/\r?\n/); pending = lines.pop()!;
  for (const line of lines) {
    const value = Number(line.trim()); if (line.trim() && Number.isFinite(value)) {
      const sample = { at: Date.now(), usedMiB: value }; gpu.push(sample);
      appendFileSync(join(directory, "gpu-device-samples.jsonl"), JSON.stringify(sample) + "\n");
    } else if (line.trim()) gpuReason = "unsupported NVIDIA device memory sample";
  }
});
monitor?.on("error", error => { gpuReason = String(error); });
}

function vram(start: number, end: number) {
  const samples = gpu.filter(s => s.at >= start && s.at <= end), baseline = [...gpu].reverse().find(s => s.at < start);
  return { source: "nvidia-smi device-0 memory.used", scope: "entire-device-including-other-processes",
    sampleIntervalMs: 250, samples: samples.length, baselineMiB: baseline?.usedMiB ?? null,
    peakMiB: samples.length ? Math.max(...samples.map(s => s.usedMiB)) : null,
    reason: samples.length ? null : gpuReason ?? "no sample within this interval" };
}
let current: ReturnType<typeof utilityProcess.fork> | undefined;
async function block(modelId: string, backend: string, repetition: number) {
  const startedAt = Date.now(), baseline = gpu.at(-1) ?? null;
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key];
  env.PATH = [join(root, ".local/toolchain/cuda/libcublas-windows-x86_64-13.2.0.9-archive/bin/x64"),
    join(root, ".local/toolchain/cuda/cuda_cudart-windows-x86_64-13.1.80-archive/bin/x64"),
    join(process.env.SystemRoot!, "System32")].join(";");
  const child = utilityProcess.fork(join(import.meta.dirname, "comparison-worker.js"),
    [root, modelId, backend, String(repetition), mode],
    { cwd: join(root, ".local/pilot"), env, execArgv: [], serviceName: "Tahtiapuri Evaluation", stdio: "pipe" });
  current = child;
  const stem = modelId + "-" + backend + "-" + repetition;
  child.stdout?.on("data", c => appendFileSync(join(directory, stem + ".log"), c));
  child.stderr?.on("data", c => appendFileSync(join(directory, stem + ".log"), c));
  await new Promise<void>((resolve, reject) => {
    let done = false;
    let watchdog: NodeJS.Timeout, exitGuard: NodeJS.Timeout;
    let active: { caseId: string; startedAt: number; text: string } | undefined;
    const arm = (ms: number) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (active) {
          const c = source.cases.find(c => c.id === active!.caseId);
          appendFileSync(join(directory, "responses.jsonl"), JSON.stringify({
            type: "result", runId, modelId, backend, repetition, caseId: active.caseId, mode: c?.mode ?? "text",
            startedAt: active.startedAt, endedAt: Date.now(), text: active.text, responseSha256: sha(active.text),
            warmup: active.caseId === "warmup", complete: false, error: "TIMEOUT_FORCED_RETIREMENT",
            firstTextMs: null, totalMs: Date.now() - active.startedAt,
            ramRssPeakBytes: null, ramReason: "worker hung before final RAM report",
            vram: vram(active.startedAt, Date.now()), factualReview: "pending-manual-review"
          }) + "\n");
          active = undefined;
        }
        child.kill();
        exitGuard = setTimeout(() => reject(new Error("OWNED_WORKER_EXIT_UNCONFIRMED")), 3000);
      }, ms);
    };
    arm(source.manifest.generation.modelLoadTimeoutMs);
    const heartbeat = setInterval(() => { try { child.postMessage("ping"); } catch {} }, 2000);
    child.on("message", (message: Record<string, any>) => {
      if (message.type === "start") {
        active = { caseId: message.caseId, startedAt: message.startedAt, text: "" };
        arm(source.manifest.generation.requestTimeoutMs + source.manifest.generation.cancelTimeoutMs);
      }
      if (message.type === "partial" && active && active.caseId === message.caseId) active.text = String(message.text).slice(0, 8192);
      if (message.type === "loaded") {
        appendFileSync(join(directory, "loads.jsonl"), JSON.stringify({ ...message, startedAt, endedAt: Date.now(),
          coldProcessReadyMs: Date.now() - startedAt, vram: vram(startedAt, Date.now()) }) + "\n");
      }
      if (message.type === "result") {
        active = undefined; arm(10_000);
        const c = source.cases.find(c => c.id === message.caseId);
        const decision = c?.mode === "json-decision" ? assessDecision(message.text, source.fixture.targets.map(t => t.id), source.fixture.atUtc, c.expectedDecision) : null;
        const row = { ...message, runId, modelId, backend, repetition, warmup: message.caseId === "warmup",
          decision, vram: vram(message.startedAt, message.endedAt), factualReview: "pending-manual-review" };
        appendFileSync(join(directory, "responses.jsonl"), JSON.stringify(row) + "\n");
        console.log(modelId + " " + backend + " r" + repetition + " " + message.caseId + " " + Math.round(message.totalMs) + "ms " + (message.error ?? message.stopReason));
      }
      if (message.type === "done") { done = true; arm(5000); }
    });
    child.once("exit", async code => {
      clearInterval(heartbeat); clearTimeout(watchdog); clearTimeout(exitGuard); if (current === child) current = undefined;
      await new Promise(r => setTimeout(r, 750));
      appendFileSync(join(directory, "blocks.jsonl"), JSON.stringify({ modelId, backend, repetition, pid: child.pid,
        startedAt, endedAt: Date.now(), code, done, beforeGpuMiB: baseline?.usedMiB ?? null,
        afterGpuMiB: gpu.at(-1)?.usedMiB ?? null }) + "\n");
      done && code === 0 ? resolve() : reject(new Error("Evaluation worker failed: " + stem));
    });
  });
}
async function run() {
let failed = false;
try {
await app.whenReady();
startMonitor();
const meta = { runId, mode, startedAtUtc: new Date().toISOString(), git,
  cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalRamBytes: totalmem(), os: release(), electron: process.versions.electron,
  sdk: "3.22.2", gpu: smiInfo, baseManifestSha256: sha(readFileSync(join(root, "tests/evaluations/local-model/pilot-manifest.json"))),
  runnerSha256: Object.fromEntries(["comparison-main.ts", "comparison-worker.ts", "inputs.ts", "decision.ts", "types.ts", "launch-comparison.mjs"].map(file =>
    [file, sha(readFileSync(join(root, "tests/evaluations/local-model", file)))])),
  nativeInventory: JSON.parse(readFileSync(join(root, ".artifacts/tests/native-inventory-t04.json"), "utf8")),
  inputSha256: source.manifest.inputSha256, lockfileSha256: sha(readFileSync(join(root, "pnpm-lock.yaml"))),
  actualSettings: { ...source.manifest.generation, maxThreads: 6, batchSize: 256, warmupsPerFreshProcess: 1, repetitions: mode === "full" ? 3 : 1 },
  caveats: ["Process-cold; OS file cache is not flushed", "GPU memory is whole-device usage, not process attribution", "SDK memoryUsage fields are estimates", "Fixed model order; other workloads and laptop power/thermals not controlled", "No production UI/queue or MCP exercise"] };
writeFileSync(join(directory, "run.json"), JSON.stringify(meta, null, 2));
writeFileSync(join(root, ".artifacts/tests/evaluations/local-model/latest-" + mode + ".json"), JSON.stringify({ directory }));
  for (const modelId of source.manifest.execution.modelOrder) for (const backend of source.manifest.execution.backends)
    for (let repetition = 1; repetition <= (mode === "full" ? 3 : 1); repetition++) {
      try { await block(modelId, backend, repetition); } catch (error) { failed = true; console.error(String(error)); if (String(error).includes("OWNED_WORKER_EXIT_UNCONFIRMED")) throw error; }
    }
} catch (error) { failed = true; console.error(String(error)); } finally {
  current?.kill();
  if (monitor && monitor.exitCode === null) {
    const ownedMonitor = monitor;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { failed = true; writeFileSync(join(directory, "cleanup-unconfirmed.json"), JSON.stringify({ monitor: true })); resolve(); }, 3000);
      ownedMonitor.once("exit", () => { clearTimeout(timer); resolve(); });
      ownedMonitor.kill();
    });
  }
  app.exit(failed ? 1 : 0);
}

}
void run();
