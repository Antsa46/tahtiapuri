import { expect, it } from "vitest";
import { access, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { NativeDevelopmentHost, type NativeHostOutcome } from "../../../apps/desktop/src/main/native-development-host.js";
import { loadNativeMcpRuntime } from "../../../apps/desktop/src/main/native-mcp-resources.js";
import { decodeNativeBootstrap } from "../../../apps/desktop/src/main/native-development-bootstrap.js";
import { childEnvironment } from "../../../apps/desktop/src/main/child-environment.js";
import type { BackendController } from "../../../apps/desktop/src/main/backend-controller.js";
import { DevelopmentService } from "../../../apps/backend/src/modules/development/application/development-service.js";
import { AssistantService } from "../../../apps/backend/src/modules/assistant/application/assistant-service.js";
import { isDevelopmentIdentity, isDevelopmentInvocation } from "@tahtiapuri/validation/development";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runtimeRoot = process.env.TAHTIAPURI_NATIVE_MCP_RUNTIME_ROOT;
const descriptorDigest = process.env.TAHTIAPURI_NATIVE_MCP_RUNTIME_DIGEST;
const runRoot = process.env.TAHTIAPURI_NATIVE_MCP_RUN_ROOT;
const enabled = process.platform === "win32" && !!runtimeRoot && !!descriptorDigest && !!runRoot;
const test = enabled ? it : it.skip;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Rpc = { jsonrpc: string; id: number; error?: unknown; result?: { tools?: { name: string }[]; structuredContent?: unknown } };
async function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined; const end = performance.now() + ms;
  try {
    const result = await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label + " deadline")), ms); })]);
    if (performance.now() >= end) throw new Error(label + " late completion");
    return result;
  } finally { clearTimeout(timer); }
}
class McpPeer {
  readonly closed: Promise<Exit>;
  readonly events: string[] = [];
  readonly replies: Rpc[] = [];
  readonly stderr: Buffer[] = [];
  observedClose = false; stdoutEnded = false; forced = false;
  private error: Error | undefined;
  private remainder: Buffer = Buffer.alloc(0);
  private outputBytes = 0; private errorBytes = 0; private sequence = 0;
  private pending = new Map<number, { resolve(value: Rpc): void; reject(error: Error): void }>();
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    this.closed = new Promise(resolveExit => child.once("close", (code, signal) => {
      this.observedClose = true; this.events.push("broker-close");
      if (this.pending.size) this.fail(new Error("Broker closed with pending RPC"));
      resolveExit({ code, signal });
    }));
    child.on("error", error => this.fail(error));
    for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe.on("error", error => this.fail(error));
    child.stdin.on("close", () => this.events.push("stdin-close"));
    child.stdout.on("end", () => { this.stdoutEnded = true; if (this.remainder.length) this.fail(new Error("Truncated MCP line")); });
    child.stdout.on("data", (bytes: Buffer) => {
      if (this.error) return;
      try {
        this.outputBytes += bytes.length; if (this.outputBytes > 1048576) throw new Error("MCP total output cap");
        this.remainder = Buffer.concat([this.remainder, bytes]);
        if (this.remainder.length > 262144) throw new Error("MCP line cap");
        let end: number;
        while ((end = this.remainder.indexOf(10)) >= 0) {
          const line = this.remainder.subarray(0, end); this.remainder = this.remainder.subarray(end + 1);
          const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)) as Rpc;
          if (!value || value.jsonrpc !== "2.0" || !Number.isSafeInteger(value.id) || this.replies.length >= 8) throw new Error("Unexpected MCP reply");
          const pending = this.pending.get(value.id); if (!pending) throw new Error("Unknown MCP reply id");
          this.pending.delete(value.id); this.replies.push(value); pending.resolve(value);
        }
      } catch (error) { this.fail(error); }
    });
    child.stderr.on("data", (bytes: Buffer) => {
      this.errorBytes += bytes.length;
      if (this.errorBytes > 16384) this.fail(new Error("Broker stderr cap"));
      else this.stderr.push(Buffer.from(bytes));
    });
  }
  private fail(error: unknown) {
    this.error ??= error instanceof Error ? error : new Error("MCP peer failure");
    for (const item of this.pending.values()) item.reject(this.error); this.pending.clear();
  }
  private write(message: object) {
    if (this.error) return Promise.reject(this.error);
    return new Promise<void>((resolveWrite, reject) => {
      this.child.stdin.write(JSON.stringify(message) + "\n", error => error ? reject(error) : resolveWrite());
    });
  }
  async call(method: string, params?: unknown, replyBudgetMs = 12000): Promise<Rpc> {
    if (this.error) throw this.error; expect(this.pending.size).toBe(0);
    const id = ++this.sequence; let value!: Promise<Rpc>;
    value = new Promise<Rpc>((resolveReply, reject) => this.pending.set(id, { resolve: resolveReply, reject }));
    try {
      return (await bounded(Promise.all([value, this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })]), replyBudgetMs, method))[0];
    } finally { this.pending.delete(id); }
  }
  initialized() { return bounded(this.write({ jsonrpc: "2.0", method: "notifications/initialized" }), 2000, "initialized-write"); }
  assertComplete() {
    expect(this.error).toBeUndefined(); expect(this.stdoutEnded).toBe(true); expect(this.remainder.length).toBe(0);
    expect(this.pending.size).toBe(0); expect(this.forced).toBe(false); expect(this.errorBytes).toBe(0);
  }
  async stopOwned() {
    if (this.observedClose) return;
    this.forced = true; this.events.push("forced-broker-stop");
    this.child.kill(); await bounded(this.closed, 5000, "owned-broker-exit");
  }
}

test("round trips real MCP status and Main STOP through the native broker candidate", async () => {
  const routineEnd = performance.now() + 80000;
  const routine = <T>(work: () => Promise<T>, cap: number, label: string): Promise<T> => {
    const remaining = routineEnd - performance.now();
    if (remaining <= 0) return Promise.reject(new Error("Functional routine deadline"));
    return bounded(work(), Math.min(cap, remaining), label);
  };
  expect(resolve(runRoot!)).toBe(runRoot); expect(resolve(runtimeRoot!)).toBe(runtimeRoot);
  expect(dirname(runRoot!)).toBe(join(projectRoot, ".artifacts/tests/native-mcp-runtime"));
  expect(basename(runRoot!)).toMatch(/^run-[a-f0-9]{32}$/);
  expect(dirname(runtimeRoot!)).toBe(join(projectRoot, ".artifacts/native/mcp-native/builds"));
  expect(basename(runtimeRoot!)).toMatch(/^build-[a-f0-9]{32}$/);
  expect(descriptorDigest).toMatch(/^[a-f0-9]{64}$/);
  const runtime = await routine(() => loadNativeMcpRuntime({ runtimeRoot: runtimeRoot!, descriptorSha256: descriptorDigest! }, new AbortController().signal), 15000, "runtime-load");
  const control = join(runRoot!, "control"), reservation = join(control, "native-session-reserved");
  let runs = 0;
  const assistant = new AssistantService({ run: async () => { ++runs; return { text: "Synthetic", info: null, error: null }; }, cancel: () => {} });
  const service = new DevelopmentService(assistant), operations: string[] = [], invocations: { operation: string; inputIsNull: boolean }[] = [];
  const development: BackendController["development"] = async (operation, value) => {
    operations.push(operation);
    if (operation === "development.status") return service.status();
    if (operation === "development.configure" && (typeof value === "string" || value === null)) return service.configure(value);
    if (operation === "development.attach" && isDevelopmentIdentity(value)) return service.attach(value);
    if (operation === "development.detach" && isDevelopmentIdentity(value)) return service.detach(value);
    if (operation === "development.invoke" && isDevelopmentInvocation(value)) {
      invocations.push({ operation: value.operation, inputIsNull: value.input === null }); return service.invoke(value);
    }
    throw new Error("Unexpected development operation");
  };
  const host = new NativeDevelopmentHost({ development }, control, runtime);
  let peer: McpPeer | undefined, outcome: NativeHostOutcome | undefined, exited: Exit | undefined;
  let context: { generation: string; pid: number; creation: string } | undefined;
  let stopping: Promise<NativeHostOutcome> | undefined;
  const requestStop = () => stopping ??= host.stop().then(value => { outcome = value; return value; });
  let stdinOpenAtMainStop = false, mainStopIssuedByTest = false, workerPresentAtEnabled = false;
  let success = false, original: unknown;
  const cleanupErrors: string[] = []; let phase = "enable";
  try {
    expect(await routine(() => host.setEnabled(true), 35000, "host-enable")).toMatchObject({ ok: true, status: { enabled: true } });
    const launch = await routine(() => readFile(join(control, "main-bootstrap.bin")), 3000, "bootstrap-read"), decoded = decodeNativeBootstrap(launch);
    context = { generation: decoded.ticket.generation, pid: decoded.main.pid, creation: decoded.main.creationTime.toString() }; launch.fill(0);
    // The production Host prepared the entire worker before publishing the
    // bootstrap. This fixture no longer copies or repairs a worker package.
    const staged = await routine(() => readdir(reservation), 3000, "prepared-reservation");
    expect(staged).toEqual(["worker"]); workerPresentAtEnabled = true;
    const stageStat = await routine(() => lstat(join(reservation, "worker"), { bigint: true }), 3000, "stage-identity");
    const reservationStat = await routine(() => lstat(reservation, { bigint: true }), 3000, "reservation-identity");
    phase = "spawn";
    // Single descriptor argument, stdio transport, no model or network endpoint.
    if (performance.now() >= routineEnd) throw new Error("No broker spawn after deadline");
    const child = spawn(runtime.broker, [join(control, "main-bootstrap.bin")], {
      cwd: join(runtimeRoot!, "bin"), stdio: ["pipe", "pipe", "pipe"], detached: true, windowsHide: true, env: childEnvironment(process.env),
    });
    peer = new McpPeer(child);
    phase = "initialize";
    expect((await routine(() => peer!.call("initialize", { protocolVersion: "2025-11-25", capabilities: {},
      clientInfo: { name: "synthetic-native-broker", version: "0.0.1" } }, 60000), 60000, "initialize-startup")).error).toBeUndefined();
    await routine(() => peer!.initialized(), 2000, "initialized"); phase = "tools-list";
    expect((await routine(() => peer!.call("tools/list"), 12000, "tools-list")).result?.tools?.map(tool => tool.name).sort()).toEqual(["cancel_probe", "model_probe", "model_status"]);
    phase = "model-status";
    const response = await routine(() => peer!.call("tools/call", { name: "model_status", arguments: {} }), 12000, "model-status");
    expect(response.error).toBeUndefined(); expect(response.result?.structuredContent).toEqual(service.status());
    expect(response.result?.structuredContent).toMatchObject({ ok: true, status: { enabled: true, connected: true } });
    expect(invocations).toEqual([{ operation: "status", inputIsNull: true }]); expect(runs).toBe(0);
    stdinOpenAtMainStop = !child.stdin.writableEnded && !child.stdin.destroyed && !peer.events.includes("stdin-close");
    expect(stdinOpenAtMainStop).toBe(true); expect(peer.observedClose).toBe(false);
    peer.events.push("main-stop"); phase = "main-stop";
    [outcome, exited] = await routine(() => {
      mainStopIssuedByTest = true; return Promise.all([requestStop(), peer!.closed]);
    }, 35000, "main-stop-and-exit");
    expect(exited).toEqual({ code: 0, signal: null }); peer.assertComplete();
    expect(outcome).toEqual({ descriptorRemoved: true, helperExitVerified: true, backendRevoked: true,
      listenerClosed: true, brokerCleanupReported: true, reservationCreated: true, reservationReleased: false, failed: false });
    const stopIndex = peer.events.indexOf("main-stop"), stdinCloseIndex = peer.events.indexOf("stdin-close");
    expect(peer.events.indexOf("broker-close")).toBeGreaterThan(stopIndex);
    // Stdin must stay open until STOP. Its optional close callback need not
    // occur before the ChildProcess close callback.
    expect(stdinCloseIndex < 0 || stdinCloseIndex > stopIndex).toBe(true);
    expect(operations.slice(-2)).toEqual(["development.detach", "development.configure"]);
    expect(service.status()).toMatchObject({ ok: true, status: { enabled: false, connected: false } });
    phase = "post-exit-journal";
    await expect(routine(() => access(join(control, "main-bootstrap.bin")), 3000, "descriptor-absence")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await routine(() => readdir(reservation), 3000, "reservation-read")).sort()).toEqual(["broker-journal.bin"]);
    const journalPath = join(reservation, "broker-journal.bin");
    const journalStat = await routine(() => lstat(journalPath), 3000, "journal-stat");
    expect(journalStat.isFile() && !journalStat.isSymbolicLink() && journalStat.nlink === 1).toBe(true);
    expect(journalStat.size).toBe(1024);
    const journal = await routine(() => readFile(journalPath), 3000, "journal-read");
    expect(journal.length).toBe(1024); expect(journal.subarray(0, 8).equals(Buffer.from([84, 77, 67, 74, 82, 78, 50, 0]))).toBe(true);
    expect(journal.readUInt32LE(8)).toBe(2); expect(journal.readUInt32LE(12)).toBe(1024); expect(journal.readUInt32LE(16)).toBe(7);
    expect(journal.readUInt32LE(20)).toBe(peer.child.pid); expect(journal.readBigUInt64LE(504)).toBeGreaterThan(0n);
    expect(BigInt(journal.readUInt32LE(64))).toBe(stageStat.dev);
    expect((BigInt(journal.readUInt32LE(68)) << 32n) | BigInt(journal.readUInt32LE(72))).toBe(stageStat.ino);
    expect(BigInt(journal.readUInt32LE(512))).toBe(reservationStat.dev);
    expect((BigInt(journal.readUInt32LE(516)) << 32n) | BigInt(journal.readUInt32LE(520))).toBe(reservationStat.ino);
    expect(journal.readUInt32LE(24)).toBe(context.pid); expect(journal.readBigUInt64LE(32).toString()).toBe(context.creation);
    expect(journal.subarray(48, 64).toString("hex")).toBe(context.generation);
    expect(journal.subarray(80, 144).toString("ascii")).toBe(runtime.packageDigest);
    expect(journal.subarray(992).toString("hex")).toBe(digest(journal.subarray(0, 992)));
    if (performance.now() >= routineEnd) throw new Error("No successful predicate after routine deadline");
    phase = "done"; success = true;
  } catch (error) { original = error; }
  finally {
    try { const alreadyRequested = !!stopping; outcome ??= await bounded(requestStop(), alreadyRequested ? 1000 : 35000, "cleanup-host-stop"); } catch (error) { cleanupErrors.push(String(error)); }
    if (peer) {
      try { await peer.stopOwned(); exited ??= await peer.closed; } catch (error) { cleanupErrors.push(String(error)); }
    }
    service.configure(null); assistant.dispose();
    // Preserve every fixture, including a successful journal. No recovery or
    // recursive removal is allowed to turn uncertain ownership into success.
    const receiptAbort = new AbortController();
    const receiptTimer = setTimeout(() => receiptAbort.abort(), 3000);
    try { await bounded(writeFile(join(runRoot!, "functional-result.json"), JSON.stringify({
      success: success && cleanupErrors.length === 0, phase, context, outcome, exit: exited, forced: peer?.forced ?? false, brokerCloseObserved: peer?.observedClose ?? false,
      operations, invocations, engineRunCalls: runs, events: peer?.events ?? [], replies: peer?.replies ?? [],
      brokerStderr: Buffer.concat(peer?.stderr ?? []).toString("utf8"), error: original instanceof Error ? original.message : original ? String(original) : null,
      cleanupErrors, evidenceScope: "Functional Node-host/Main-STOP only; broker-reported cleanup and local post-state, no independent OS/network/profile proof",
      fixturePreserved: true, recoveryAttempted: false, inspectorExecuted: false, stdinEndedByTest: false,
      stdinOpenAtMainStop, mainStopIssuedByTest, workerPresentAtEnabled, stdoutEnded: peer?.stdoutEnded ?? false,
      terminalSuccessRequires: "One passed Vitest case, actual process exit0, no timeout/cleanup errors; this receipt alone is not terminal success",
    }, null, 2) + "\n", { flag: "wx", signal: receiptAbort.signal }), 3000, "functional-receipt-write"); }
    finally { clearTimeout(receiptTimer); }
  }
  if (original) throw original;
  expect(cleanupErrors).toEqual([]); expect(success).toBe(true);
}, 130000);
