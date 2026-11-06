import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeMuxFrame, McpMuxReader, MuxKind, type MuxFrame } from "./mcp-mux-wire.js";

async function exerciseWorker(entry: string, loader?: string, executable = process.execPath) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key];
  const child = spawn(executable, ["--max-old-space-size=128", ...(loader ? ["--import", pathToFileURL(loader).href] : []), entry], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let sequence = 1, request = 0, remainder = "", stderrBytes = 0, forced = false, observedClose = false, expectedClose = false;
  let phase = "readiness";
  const commands: string[] = [], pending = new Map<number, (reply: { result?: { tools?: { name: string }[]; structuredContent?: unknown }; error?: unknown }) => void>();
  let resolveReady!: () => void, fail!: (error: Error) => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const failure = new Promise<never>((_resolve, reject) => { fail = reject; });
  // Register rejection handling before the child can fail during construction.
  void failure.catch(() => {});
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => { observedClose = true; resolve({ code, signal }); if (!expectedClose) fail(new Error(`Synthetic MCP worker exited during ${phase}: code=${code}, signal=${signal}, stderrBytes=${stderrBytes}.`)); }));
  const timer = setTimeout(() => { forced = true; child.kill(); fail(new Error(`Synthetic MCP worker timed out during ${phase}.`)); }, 8000);
  const send = (kind: MuxFrame["kind"], body: Buffer) => child.stdin.write(encodeMuxFrame({ kind, body }, sequence++, "to-worker"));
  const reader = new McpMuxReader("from-worker", frame => {
    if (frame.kind === MuxKind.ready) { resolveReady(); return; }
    if (frame.kind === MuxKind.development) {
      const command = JSON.parse(frame.body.toString()) as { id: string; operation: string };
      commands.push(command.operation);
      send(MuxKind.development, Buffer.from(JSON.stringify({ id: command.id, result: { ok: false, code: "INVALID_INPUT" } }) + "\n"));
      return;
    }
    remainder += frame.body.toString();
    let end: number;
    while ((end = remainder.indexOf("\n")) >= 0) {
      const reply = JSON.parse(remainder.slice(0, end)); remainder = remainder.slice(end + 1);
      const resolve = pending.get(reply.id); if (!resolve) throw new Error("Unexpected synthetic MCP response.");
      pending.delete(reply.id); resolve(reply);
    }
  }, fail);
  child.on("error", fail); child.stdin.on("error", fail); child.stdout.on("error", fail); child.stderr.on("error", fail);
  child.stdout.on("data", (bytes: Buffer) => reader.write(bytes));
  child.stdout.on("end", () => reader.end());
  child.stderr.on("data", (bytes: Buffer) => { stderrBytes += bytes.length; if (stderrBytes > 16_384) { forced = true; child.kill(); fail(new Error("Synthetic stderr cap.")); } });
  const call = (method: string, params?: unknown) => Promise.race([new Promise<{ result?: { tools?: { name: string }[]; structuredContent?: unknown }; error?: unknown }>(resolve => {
    const id = ++request; pending.set(id, resolve);
    send(MuxKind.mcp, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n"));
  }), failure]);
  try {
    await Promise.race([ready, failure]);
    phase = "initialization";
    expect((await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic-pipe-owner", version: "0.0.1" } })).error).toBeUndefined();
    send(MuxKind.mcp, Buffer.from('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'));
    phase = "tools-list";
    expect((await call("tools/list")).result?.tools?.map(tool => tool.name).sort()).toEqual(["cancel_probe", "model_probe", "model_status"]);
    phase = "model-status";
    expect((await call("tools/call", { name: "model_status", arguments: {} })).result?.structuredContent).toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(commands).toEqual(["status"]);
    phase = "owner-close"; expectedClose = true;
    send(MuxKind.close, Buffer.alloc(0)); child.stdin.end();
    expect(await Promise.race([closed, failure])).toEqual({ code: 0, signal: null });
    expect(forced).toBe(false); expect(stderrBytes).toBe(0); expect(remainder).toBe(""); expect(pending.size).toBe(0);
  } finally {
    clearTimeout(timer); reader.stop();
    if (!observedClose) {
      forced = true;
      const requested = child.kill();
      let cleanupTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([closed, new Promise<never>((_resolve, reject) => {
          cleanupTimer = setTimeout(() => reject(new Error(`Owned synthetic worker closure unresolved: pid=${child.pid}, killRequested=${requested}.`)), 2000);
        })]);
      } finally { clearTimeout(cleanupTimer); }
    }
  }
}
it.skipIf(process.platform !== "win32")("runs the fixed worker over real Windows Node pipes and exits after owner CLOSE", async () => {
  await exerciseWorker(fileURLToPath(new URL("../dist/native-worker-entry.js", import.meta.url)));
}, 12_000);
const bundle = process.env.TAHTIAPURI_MCP_TEST_BUNDLE;
const loader = process.env.TAHTIAPURI_MCP_TEST_LOADER;
it.skipIf(process.platform !== "win32" || !bundle || !loader)("runs an explicitly supplied bundle with repository dependency resolution blocked", async () => {
  await exerciseWorker(bundle!, loader!, process.env.TAHTIAPURI_MCP_TEST_NODE);
}, 12_000);
