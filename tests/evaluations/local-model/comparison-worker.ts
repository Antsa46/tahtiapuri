import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getLlama, getModuleVersion, LlamaChatSession, JinjaTemplateChatWrapper } from "node-llama-cpp";
import { inputs, promptFor, sha } from "./inputs.js";
const [root, modelId, backend, blockText, mode] = process.argv.slice(-5);
if (!root || !["qwen3-4b-q4-k-m", "qwen3-8b-q4-k-m"].includes(modelId!) || !["cpu", "cuda"].includes(backend!)
  || !["1", "2", "3"].includes(blockText!) || !["full", "smoke"].includes(mode!)) throw new Error("Invalid fixed evaluation arguments");
const parent = process.parentPort;
if (!parent) throw new Error("UtilityProcess required");
const send = (value: object) => parent.postMessage(value);
let parentSeen = Date.now();
parent.on("message", event => { if (event.data === "ping") parentSeen = Date.now(); });
setInterval(() => { if (Date.now() - parentSeen > 10_000) process.exit(1); }, 2000).unref();
const source = inputs(root), gen = source.manifest.generation;
const profile = source.manifest.models.find((m: { id: string }) => m.id === modelId);
const file = join(root, ".local/models", profile.file);
const started = performance.now();
if (await getModuleVersion() !== "3.22.2") throw new Error("Unexpected SDK version");
const st = await lstat(file);
if (!st.isFile() || st.isSymbolicLink() || st.size !== profile.bytes) throw new Error("Invalid model file");
const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk);
if (hash.digest("hex") !== profile.sha256) throw new Error("Invalid GGUF SHA");
const verifyMs = performance.now() - started;
const previous = process.env.ELECTRON_RUN_AS_NODE;
let llama: Awaited<ReturnType<typeof getLlama>>;
const engineStart = performance.now();
try {
  process.env.ELECTRON_RUN_AS_NODE = "1";
  llama = await getLlama({ gpu: backend === "cuda" ? "cuda" : false, build: "never", skipDownload: true,
    usePrebuiltBinaries: true, progressLogs: false, maxThreads: 6 });
} finally {
  if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = previous;
}
if (llama.gpu !== (backend === "cuda" ? "cuda" : false)) throw new Error("Implicit fallback rejected");
const engineInitMs = performance.now() - engineStart;
const loadStart = performance.now();
const model = await llama.loadModel({ modelPath: file, gpuLayers: backend === "cuda" ? "max" : 0 });
const modelLoadMs = performance.now() - loadStart;
const metadata = model.fileInfo.metadata as unknown as { tokenizer?: { chat_template?: unknown } };
const template = metadata.tokenizer?.chat_template;
if (typeof template !== "string" || sha(template) !== profile.expectedChatTemplateSha256) throw new Error("Template checksum mismatch");
send({ type: "loaded", modelId, backend, block: Number(blockText), verifyMs, engineInitMs, modelLoadMs,
  gpuLayers: model.gpuLayers, modelMemoryEstimate: model.memoryUsage, modelSha256: profile.sha256, templateSha256: sha(template),
  sdkVersion: await getModuleVersion(), devices: await llama.getGpuDeviceNames() });
const grammar = await llama.createGrammarForJsonSchema(source.schema);
const warmup = { ...source.cases[0]!, id: "warmup", promptFi: "Vastaa yhdellä lyhyellä virkkeellä: mitä tämä synteettinen aineisto kuvaa?" };
for (const c of [warmup, ...(mode === "smoke" ? source.cases.slice(0, 1) : source.cases)]) {
  const at = Date.now(), t = performance.now();
  let rssPeak = process.memoryUsage.rss(), samples = 0;
  const sample = () => { rssPeak = Math.max(rssPeak, process.memoryUsage.rss()); samples++; };
  sample(); const timer = setInterval(sample, 100);
  const abort = new AbortController(); const timeout = setTimeout(() => abort.abort(), gen.requestTimeoutMs);
  let context: Awaited<ReturnType<typeof model.createContext>> | undefined, session: LlamaChatSession | undefined;
  let firstTextMs: number | null = null, firstTokenMs: number | null = null;
  let partial = "", lastPartial = 0;
  send({ type: "start", caseId: c.id, startedAt: at });
  try {
    const prompt = promptFor(source.fixture, c, source.schema);
    const joined = source.system + prompt + JSON.stringify(c.history ?? []);
    if (model.tokenize(joined).length > gen.maxInputTokens) throw new Error("Input token limit exceeded");
    context = await model.createContext({ contextSize: gen.contextTokens, sequences: 1, batchSize: 256 });
    session = new LlamaChatSession({ contextSequence: context.getSequence(),
      chatWrapper: new JinjaTemplateChatWrapper({ template, reasoning: false }), systemPrompt: source.system });
    if (c.history) session.setChatHistory([{ type: "system", text: source.system }, ...c.history.map(h =>
      h.role === "user" ? { type: "user" as const, text: h.textFi } : { type: "model" as const, response: [h.textFi] })]);
    const meter = session.sequence.tokenMeter.getState();
    const output = await session.promptWithMeta(prompt, { signal: abort.signal, maxTokens: gen.maxOutputTokens,
      temperature: gen.temperature, seed: gen.seed, repeatPenalty: { penalty: gen.repeatPenalty },
      ...(c.mode === "json-decision" ? { grammar } : {}),
      onTextChunk: text => {
        if (firstTextMs === null && text.length) firstTextMs = performance.now() - t;
        partial = (partial + text).slice(0, 8192);
        if (Date.now() - lastPartial >= 250) { send({ type: "partial", caseId: c.id, text: partial }); lastPartial = Date.now(); }
      },
      onToken: tokens => { if (firstTokenMs === null && tokens.length) firstTokenMs = performance.now() - t; } });
    sample();
    send({ type: "result", caseId: c.id, mode: c.mode, startedAt: at, endedAt: Date.now(),
      text: output.responseText, responseSha256: sha(output.responseText), firstTextMs, firstTokenMs,
      totalMs: performance.now() - t, tokens: session.sequence.tokenMeter.diff(meter), stopReason: output.stopReason,
      complete: output.stopReason !== "maxTokens" && output.stopReason !== "abort",
      ramRssPeakBytes: rssPeak, ramSamples: samples, ramSampleIntervalMs: 100,
      modelMemoryEstimate: model.memoryUsage, contextMemoryEstimate: context.memoryUsage,
      contextTokens: context.contextSize, wrapper: "JinjaTemplateChatWrapper", reasoning: false });
  } catch (error) {
    send({ type: "result", caseId: c.id, mode: c.mode, startedAt: at, endedAt: Date.now(), text: partial, responseSha256: sha(partial),
      error: abort.signal.aborted ? "TIMEOUT" : String(error), totalMs: performance.now() - t,
      firstTextMs, firstTokenMs, complete: false, ramRssPeakBytes: rssPeak, ramSamples: samples });
  } finally {
    clearTimeout(timeout); clearInterval(timer); session?.dispose(); await context?.dispose();
  }
}
await model.dispose(); await llama.dispose();
send({ type: "done" }); process.exit(0);
