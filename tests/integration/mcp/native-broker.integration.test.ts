import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { access, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { NativeDevelopmentHost, type NativeHostOutcome } from "../../../apps/desktop/src/main/native-development-host.js";
import { loadNativeMcpRuntime } from "../../../apps/desktop/src/main/native-mcp-resources.js";
import { securePrivateDirectory } from "../../../apps/desktop/src/main/private-directory.js";
import { decodeNativeBootstrap, encodeNativeBootstrap } from "../../../apps/desktop/src/main/native-development-bootstrap.js";
import { childEnvironment } from "../../../apps/desktop/src/main/child-environment.js";
import type { BackendController } from "../../../apps/desktop/src/main/backend-controller.js";
import { DevelopmentService } from "../../../apps/backend/src/modules/development/application/development-service.js";
import { AssistantService } from "../../../apps/backend/src/modules/assistant/application/assistant-service.js";
import { isDevelopmentIdentity, isDevelopmentInvocation } from "@tahtiapuri/validation/development";

const traceState = vi.hoisted(() => ({ trace: undefined as ReturnType<typeof import("./native-process-trace.js").createNativeProcessTrace> | undefined }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { createNativeProcessTrace } = await import("./native-process-trace.js");
  traceState.trace = createNativeProcessTrace(); return traceState.trace.wrap(actual);
});
const trace = traceState.trace!;
let traceScope = trace.current(), traceSequence = 0, blockedBeforeStart = false;
let traceAbort = new AbortController(), tracePending = new Set<Promise<unknown>>();

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runtimeRoot = process.env.TAHTIAPURI_NATIVE_MCP_RUNTIME_ROOT;
const descriptorDigest = process.env.TAHTIAPURI_NATIVE_MCP_RUNTIME_DIGEST;
const runRoot = process.env.TAHTIAPURI_NATIVE_MCP_RUN_ROOT;
const enabled = process.platform === "win32" && !!runtimeRoot && !!descriptorDigest && !!runRoot;
const test = enabled ? it : it.skip;
let functionalTainted = false;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
beforeEach(() => {
  blockedBeforeStart = functionalTainted; traceScope = trace.begin(); traceAbort = new AbortController(); tracePending = new Set<Promise<unknown>>();
});
afterEach(async () => {
  if (!enabled) return;
  const scope = traceScope, controller = traceAbort, pending = tracePending;
  const deadline = performance.now() + 6000, failures: string[] = [];
  trace.note(scope, "cleanup-request", "functional-case"); controller.abort();
  const requested = new Set<ReturnType<typeof trace.children>[number]["child"]>();
  for (;;) {
    const children = trace.children(scope), unclosed = children.filter(owned => !owned.record.observedClose);
    if (!pending.size && !unclosed.length) break;
    if (performance.now() >= deadline) { failures.push("Owned cleanup deadline exceeded"); break; }
    // Pending verification may create a child after a previous iteration.
    // Re-read the owned handle list; never search or kill by process name/PID.
    for (const owned of unclosed) {
      if (requested.has(owned.child)) continue;
      if (performance.now() >= deadline) break;
      requested.add(owned.child);
      try { owned.child.kill(); } catch { failures.push("Owned child termination request failed"); }
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) { failures.push("Owned cleanup deadline exceeded"); break; }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(20, remaining)); }),
        ...[...pending].map(value => value.then(() => undefined, () => undefined)),
        ...unclosed.map(owned => owned.closed),
      ]);
    } finally { clearTimeout(timer); }
  }
  const children = trace.children(scope), allChildClosesKnown = children.every(owned => owned.record.observedClose);
  const killRequests = scope.events.filter(event => event.event === "kill-request").length;
  if (performance.now() >= deadline) failures.push("Owned cleanup ended after deadline");
  if (requested.size || killRequests || !allChildClosesKnown || scope.overflow || scope.uncertain || failures.length || pending.size) functionalTainted = true;
  const receipt = { scope, children: trace.records(scope), allChildClosesKnown, forcedCleanupRequests: requested.size, killRequests,
    cleanupErrors: failures, pendingOperations: pending.size, blockedByPriorCase: blockedBeforeStart };
  try {
    await bounded(writeFile(join(runRoot!, "functional-process-case-" + (++traceSequence) + ".json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" }), 3000, "trace-receipt");
  } catch (error) { functionalTainted = true; throw error; }
  expect(failures).toEqual([]); expect(requested.size).toBe(0); expect(killRequests).toBe(0); expect(allChildClosesKnown).toBe(true);
  expect(scope.overflow).toBe(false); expect(scope.uncertain).toBe(false); expect(pending.size).toBe(0);
}, 12000);
type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Rpc = { jsonrpc: string; id: number; error?: unknown; result?: { tools?: { name: string }[]; structuredContent?: unknown } };
async function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined; const end = performance.now() + ms;
  try {
    const result = await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label + " deadline")), ms); })]);
    if (performance.now() >= end) throw new Error(label + " late completion");
    return result;
  } catch (error) {
    if (performance.now() >= end) throw new Error(label + " late completion");
    throw error;
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
  functionalTainted = true;
  const routineEnd = performance.now() + 80000;
  const caseScope = traceScope, caseAbort = traceAbort, pending = tracePending;
  const routine = <T>(work: (deadline: number) => Promise<T>, cap: number, label: string): Promise<T> =>
    trace.within(caseScope, work, cap, label, { end: routineEnd, controller: caseAbort, pending,
      taint: () => { functionalTainted = true; } });
  expect(resolve(runRoot!)).toBe(runRoot); expect(resolve(runtimeRoot!)).toBe(runtimeRoot);
  expect(dirname(runRoot!)).toBe(join(projectRoot, ".artifacts/tests/native-mcp-runtime"));
  expect(basename(runRoot!)).toMatch(/^run-[a-f0-9]{32}$/);
  expect(dirname(runtimeRoot!)).toBe(join(projectRoot, ".artifacts/native/mcp-native/builds"));
  expect(basename(runtimeRoot!)).toMatch(/^build-[a-f0-9]{32}$/);
  expect(descriptorDigest).toMatch(/^[a-f0-9]{64}$/);
  const runtime = await routine(() => loadNativeMcpRuntime({ runtimeRoot: runtimeRoot!, descriptorSha256: descriptorDigest! }, caseAbort.signal), 15000, "runtime-load");
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
  let context: { generation: string; pid: number; creation: string; descriptorDigest: string } | undefined;
  let stopping: Promise<NativeHostOutcome> | undefined;
  const requestStop = () => stopping ??= host.stop().then(value => { outcome = value; return value; });
  let stdinOpenAtMainStop = false, mainStopIssuedByTest = false, workerPresentAtEnabled = false;
  let success = false, original: unknown;
  let releaseBootstrap: Buffer | undefined, cleanReleased = false;
  const cleanupErrors: string[] = []; let phase = "enable";
  const rejectedPeers: McpPeer[] = [];
  const rejectBroker = async (file: string, stage: string, code: number) => {
    if (performance.now() >= routineEnd) throw new Error("No rejected broker spawn after deadline");
    const rejected = new McpPeer(spawn(runtime.broker, [file], { windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"], env: childEnvironment(process.env) }));
    rejectedPeers.push(rejected);
    expect(await routine(() => rejected.closed, 8000, "rejected-broker-exit")).toEqual({ code: 1, signal: null });
    expect(rejected.forced).toBe(false); expect(rejected.stdoutEnded).toBe(true); expect(rejected.replies).toEqual([]);
    expect(JSON.parse(Buffer.concat(rejected.stderr).toString("utf8"))).toEqual({ stage, code });
  };
  try {
    phase = "generic-publication-bypass";
    const bypassControl = join(runRoot!, "bypass-control"), bypassFile = join(bypassControl, "main-bootstrap.bin");
    await routine(() => securePrivateDirectory(bypassControl, caseAbort.signal), 6000, "bypass-control");
    const main = await routine(() => runtime.helpers.identity(caseAbort.signal), 6000, "bypass-identity");
    const bypass = encodeNativeBootstrap({ main, pipeNonce: "11".repeat(16), ticket: { generation: "22".repeat(16), token: "33".repeat(32) } });
    try {
      await routine(deadline => runtime.helpers.operate("publish", bypassFile, bypass, caseAbort.signal, deadline), 6000, "generic-publish");
      await rejectBroker(bypassFile, "mcp-session-lease-open", 2);
      expect((await routine(() => readFile(bypassFile), 3000, "bypass-descriptor")).equals(bypass)).toBe(true);
      for (const name of ["native-session.lease", "native-session.bin", "native-session-reserved"])
        await expect(routine(() => access(join(bypassControl, name)), 3000, "bypass-absent")).rejects.toMatchObject({ code: "ENOENT" });
    } finally { bypass.fill(0); }
    phase = "enable";
    expect(await routine(() => host.setEnabled(true), 35000, "host-enable")).toMatchObject({ ok: true, status: { enabled: true } });
    const launch = await routine(() => readFile(join(control, "main-bootstrap.bin")), 3000, "bootstrap-read"), decoded = decodeNativeBootstrap(launch);
    context = { generation: decoded.ticket.generation, pid: decoded.main.pid, creation: decoded.main.creationTime.toString(), descriptorDigest: digest(launch) };
    releaseBootstrap = Buffer.from(launch);
    // The production Host prepared the entire worker before publishing the
    // bootstrap. This fixture no longer copies or repairs a worker package.
    const staged = await routine(() => readdir(reservation), 3000, "prepared-reservation");
    expect(staged).toEqual(["worker"]); workerPresentAtEnabled = true;
    const stageStat = await routine(() => lstat(join(reservation, "worker"), { bigint: true }), 3000, "stage-identity");
    const reservationStat = await routine(() => lstat(reservation, { bigint: true }), 3000, "reservation-identity");
    const sessionPath = join(control, "native-session.bin"), leasePath = join(control, "native-session.lease");
    const ready = await routine(() => readFile(sessionPath), 3000, "ready-session");
    expect(ready.length).toBe(1024); expect(ready.subarray(0, 8).equals(Buffer.from([84, 77, 67, 83, 69, 83, 49, 0]))).toBe(true);
    expect(ready.readUInt32LE(8)).toBe(1); expect(ready.readUInt32LE(12)).toBe(1024); expect(ready.readUInt32LE(16)).toBe(1);
    expect(ready.readUInt32LE(20)).toBe(context.pid); expect(ready.readBigUInt64LE(24).toString()).toBe(context.creation);
    expect(ready.subarray(32, 48).toString("hex")).toBe(context.generation);
    expect(ready.subarray(384, 416).toString("hex")).toBe(context.descriptorDigest);
    expect(ready.subarray(112, 176).toString("ascii")).toBe(runtime.packageDigest);
    expect(ready.subarray(992).equals(createHash("sha256").update(ready.subarray(0, 992)).digest())).toBe(true);
    const leaseHeader = await routine(() => readFile(leasePath), 3000, "lease-header");
    expect(leaseHeader.length).toBe(32); expect(leaseHeader.subarray(0, 8).toString("ascii")).toBe("TMCLEAS1");
    const leaseStat = await routine(() => lstat(leasePath, { bigint: true }), 3000, "lease-identity");
    const controlStat = await routine(() => lstat(control, { bigint: true }), 3000, "control-identity");
    for (const [offset, stat] of [[48, controlStat], [60, reservationStat], [72, stageStat], [84, leaseStat]] as const) {
      expect(BigInt(ready.readUInt32LE(offset))).toBe(stat.dev);
      expect((BigInt(ready.readUInt32LE(offset + 4)) << 32n) | BigInt(ready.readUInt32LE(offset + 8))).toBe(stat.ino);
    }
    phase = "wrong-descriptor-binding";
    const foreign = Buffer.from(launch); foreign[32] = foreign[32]! ^ 1;
    try {
      await routine(deadline => runtime.helpers.operate("consume", join(control, "main-bootstrap.bin"), launch, caseAbort.signal, deadline), 6000, "consume-original");
      await routine(deadline => runtime.helpers.operate("publish", join(control, "main-bootstrap.bin"), foreign, caseAbort.signal, deadline), 6000, "publish-foreign");
      await rejectBroker(join(control, "main-bootstrap.bin"), "mcp-session-context", 5);
      expect((await routine(() => readFile(sessionPath), 3000, "unchanged-ready")).equals(ready)).toBe(true);
      await expect(routine(() => access(join(reservation, "broker-journal.bin")), 3000, "no-rejected-journal")).rejects.toMatchObject({ code: "ENOENT" });
      expect(operations).not.toContain("development.attach");
      // Only a known rejected child exit and unchanged READY allow restoring
      // this test's original descriptor. No ambiguous state is repaired.
      await routine(deadline => runtime.helpers.operate("consume", join(control, "main-bootstrap.bin"), foreign, caseAbort.signal, deadline), 6000, "consume-foreign");
      await routine(deadline => runtime.session("publish", join(control, "main-bootstrap.bin"), launch, caseAbort.signal, deadline), 7000, "publish-original");
    } finally { launch.fill(0); foreign.fill(0); }
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
    await expect(routine(() => readFile(leasePath), 3000, "exclusive-lease-read")).rejects.toMatchObject({ code: "EBUSY" });
    await expect(routine(() => readFile(sessionPath), 3000, "exclusive-session-read")).rejects.toMatchObject({ code: "EBUSY" });
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
    const admitted = await routine(() => readFile(sessionPath), 3000, "admitted-session");
    expect(admitted.readUInt32LE(16)).toBe(2); expect(admitted.readUInt32LE(96)).toBe(peer.child.pid);
    expect(admitted.readBigUInt64LE(104)).toBeGreaterThan(0n);
    expect(admitted.subarray(384, 416).toString("hex")).toBe(context.descriptorDigest);
    expect(admitted.subarray(992).equals(createHash("sha256").update(admitted.subarray(0, 992)).digest())).toBe(true);
    expect((await routine(() => readFile(leasePath), 3000, "released-lease")).equals(leaseHeader)).toBe(true);
    phase = "native-clean-release";
    const journalIdentity = await routine(() => lstat(journalPath, { bigint: true }), 3000, "source-journal-identity");
    const sessionIdentity = await routine(() => lstat(sessionPath, { bigint: true }), 3000, "source-session-identity");
    // Actual broker close was already observed. Native code independently
    // applies its recorded broker/worker exit policy and named Job check.
    await routine(deadline => runtime.session("release-clean", join(control, "main-bootstrap.bin"), releaseBootstrap!,
      caseAbort.signal, deadline), 7000, "native-clean-release");
    await expect(routine(() => access(reservation), 3000, "released-reservation-absence")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await routine(() => readFile(sessionPath), 3000, "preserved-admitted-session")).equals(admitted)).toBe(true);
    expect((await routine(() => readFile(leasePath), 3000, "preserved-original-lease")).equals(leaseHeader)).toBe(true);
    expect((await routine(() => readdir(control), 3000, "clean-control-shape")).sort()).toEqual([
      "native-session-clean-release.bin", "native-session-clean-released.bin", "native-session.bin", "native-session.lease",
    ].sort());
    const intentPath = join(control, "native-session-clean-release.bin"), completionPath = join(control, "native-session-clean-released.bin");
    const intentStat = await routine(() => lstat(intentPath, { bigint: true }), 3000, "clean-intent-stat");
    const doneStat = await routine(() => lstat(completionPath, { bigint: true }), 3000, "clean-completion-stat");
    expect(intentStat.isFile() && !intentStat.isSymbolicLink() && intentStat.nlink === 1n && intentStat.size === 2048n).toBe(true);
    expect(doneStat.isFile() && !doneStat.isSymbolicLink() && doneStat.nlink === 1n && doneStat.size === 1024n).toBe(true);
    const intent = await routine(() => readFile(intentPath), 3000, "clean-intent-read");
    const done = await routine(() => readFile(completionPath), 3000, "clean-completion-read");
    const fileId = (bytes: Buffer, at: number, stat: { dev: bigint; ino: bigint }) => {
      expect(BigInt(bytes.readUInt32LE(at))).toBe(stat.dev);
      expect((BigInt(bytes.readUInt32LE(at + 4)) << 32n) | BigInt(bytes.readUInt32LE(at + 8))).toBe(stat.ino);
    };
    expect(intent.subarray(0, 8).equals(Buffer.from([84, 77, 67, 67, 76, 83, 49, 0]))).toBe(true);
    expect(intent.readUInt32LE(8)).toBe(1); expect(intent.readUInt32LE(12)).toBe(2048); expect(intent.readUInt32LE(16)).toBe(1);
    expect(intent.subarray(20, 32).equals(Buffer.alloc(12))).toBe(true);
    expect(intent.subarray(32, 448).equals(admitted.subarray(0, 416))).toBe(true);
    expect(intent.subarray(448, 480).toString("hex")).toBe(digest(admitted)); fileId(intent, 480, sessionIdentity);
    expect(intent.subarray(492, 524).toString("hex")).toBe(digest(journal)); fileId(intent, 524, journalIdentity); fileId(intent, 536, intentStat);
    expect(intent.subarray(548, 992).equals(Buffer.alloc(444))).toBe(true);
    expect(intent.subarray(992, 2016).equals(journal)).toBe(true);
    expect(intent.subarray(2016).toString("hex")).toBe(digest(intent.subarray(0, 2016)));
    expect(done.subarray(0, 8).equals(Buffer.from([84, 77, 67, 67, 76, 68, 49, 0]))).toBe(true);
    expect(done.readUInt32LE(8)).toBe(1); expect(done.readUInt32LE(12)).toBe(1024);
    expect(done.subarray(16, 48).toString("hex")).toBe(digest(intent)); fileId(done, 48, intentStat);
    expect(done.subarray(60, 72).equals(admitted.subarray(48, 60))).toBe(true);
    expect(done.subarray(72, 84).equals(admitted.subarray(84, 96))).toBe(true);
    expect(done.readUInt32LE(84)).toBe(context.pid); expect(done.readBigUInt64LE(88).toString()).toBe(context.creation);
    expect(done.subarray(96, 112).toString("hex")).toBe(context.generation);
    expect(done.subarray(112, 144).toString("hex")).toBe(digest(admitted));
    expect(done.subarray(144, 176).toString("hex")).toBe(digest(journal)); fileId(done, 176, journalIdentity);
    expect(done.readUInt32LE(188)).toBe(1); expect(done.subarray(192, 992).equals(Buffer.alloc(800))).toBe(true);
    expect(done.subarray(992).toString("hex")).toBe(digest(done.subarray(0, 992)));
    await routine(deadline => runtime.session("release-clean", join(control, "main-bootstrap.bin"), releaseBootstrap!,
      caseAbort.signal, deadline), 7000, "same-clean-completion-retry");
    expect((await routine(() => readFile(completionPath), 3000, "same-clean-completion")).equals(done)).toBe(true);
    expect((await routine(() => readFile(intentPath), 3000, "same-clean-intent")).equals(intent)).toBe(true);
    cleanReleased = true; phase = "done"; success = true;
  } catch (error) { original = error; }
  finally {
    try { const alreadyRequested = !!stopping; outcome ??= await bounded(requestStop(), alreadyRequested ? 1000 : 35000, "cleanup-host-stop"); } catch (error) { cleanupErrors.push(String(error)); }
    if (peer) {
      try { await peer.stopOwned(); exited ??= await peer.closed; } catch (error) { cleanupErrors.push(String(error)); }
    }
    for (const rejected of rejectedPeers) {
      try { await rejected.stopOwned(); } catch (error) { cleanupErrors.push(String(error)); }
    }
    releaseBootstrap?.fill(0); service.configure(null); assistant.dispose();
    functionalTainted ||= !!original || !success || cleanupErrors.length !== 0 || !!peer?.forced || !peer?.observedClose;
    // Preserve control/session/lease/intent/completion evidence. Only the
    // package-bound fixed release operation may retire reservation data.
    const receiptAbort = new AbortController();
    const receiptTimer = setTimeout(() => receiptAbort.abort(), 3000);
    try { await bounded(writeFile(join(runRoot!, "functional-result.json"), JSON.stringify({
      success: success && cleanupErrors.length === 0, phase, context, outcome, exit: exited, forced: peer?.forced ?? false, brokerCloseObserved: peer?.observedClose ?? false,
      operations, invocations, engineRunCalls: runs, events: peer?.events ?? [], replies: peer?.replies ?? [],
      brokerStderr: Buffer.concat(peer?.stderr ?? []).toString("utf8"), error: original instanceof Error ? original.message : original ? String(original) : null,
      cleanupErrors, cleanReleased, evidenceScope: "Functional Node-host/Main-STOP plus package-bound native admitted retirement and same-completion retry after actual broker close; fresh recorded-process/Job policy, no complete profile-storage/network/default-Electron/rearm acceptance",
      fixturePreserved: true, recoveryAttempted: false, inspectorExecuted: false, stdinEndedByTest: false,
      nativeRejections: rejectedPeers.map(rejected => ({ actualClose: rejected.observedClose, forced: rejected.forced,
        stderr: Buffer.concat(rejected.stderr).toString("utf8") })),
      stdinOpenAtMainStop, mainStopIssuedByTest, workerPresentAtEnabled, stdoutEnded: peer?.stdoutEnded ?? false,
      terminalSuccessRequires: "One passed Vitest case, actual process exit0, no timeout/cleanup errors; this receipt alone is not terminal success",
    }, null, 2) + "\n", { flag: "wx", signal: receiptAbort.signal }), 3000, "functional-receipt-write"); }
    catch (error) { functionalTainted = true; throw error; }
    finally { clearTimeout(receiptTimer); }
  }
  if (original) throw original;
  expect(cleanupErrors).toEqual([]); expect(success).toBe(true);
  functionalTainted = false;
}, 130000);

// Real loader and native release CLI; synthetic backend, without a broker client.
test("production Host disable releases a sealed never-admitted session", async () => {
  if (functionalTainted) throw new Error("Earlier functional case did not complete safely");
  functionalTainted = true;
  const end = performance.now() + 80000;
  const caseScope = traceScope, caseAbort = traceAbort, pending = tracePending;
  const step = <T>(work: (deadline: number) => Promise<T>, cap: number, label: string): Promise<T> =>
    trace.within(caseScope, work, cap, label, { end, controller: caseAbort, pending,
      taint: () => { functionalTainted = true; } });
  expect(resolve(runRoot!)).toBe(runRoot); expect(resolve(runtimeRoot!)).toBe(runtimeRoot);
  expect(dirname(runRoot!)).toBe(join(projectRoot, ".artifacts/tests/native-mcp-runtime"));
  expect(basename(runRoot!)).toMatch(/^run-[a-f0-9]{32}$/);
  expect(dirname(runtimeRoot!)).toBe(join(projectRoot, ".artifacts/native/mcp-native/builds"));
  expect(basename(runtimeRoot!)).toMatch(/^build-[a-f0-9]{32}$/);
  const fixed = (path: string, size: number) => step(async () => {
    const before = await lstat(path, { bigint: true });
    expect(before.isFile()).toBe(true); expect(before.nlink).toBe(1n); expect(before.size).toBe(BigInt(size));
    const bytes = await readFile(path), after = await lstat(path, { bigint: true });
    expect(after.isFile()).toBe(true); expect(bytes.length).toBe(size);
    for (const key of ["dev", "ino", "size", "nlink", "mtimeNs", "ctimeNs"] as const) expect(after[key]).toBe(before[key]);
    return { bytes, id: after };
  }, 3000, "pristine-fixed-readback");
  const runtime = await step(() => loadNativeMcpRuntime({ runtimeRoot: runtimeRoot!, descriptorSha256: descriptorDigest! }, caseAbort.signal), 15000, "pristine-runtime");
  const control = join(runRoot!, "pristine-control"), file = join(control, "main-bootstrap.bin"), operations: string[] = [];
  let engineRuns = 0;
  const assistant = new AssistantService({ run: async () => { ++engineRuns; return { text: "Synthetic", info: null, error: null }; }, cancel: () => {} });
  const service = new DevelopmentService(assistant);
  const development: BackendController["development"] = async (operation, value) => {
    operations.push(operation);
    if (operation === "development.status") return service.status();
    if (operation === "development.configure" && (typeof value === "string" || value === null)) return service.configure(value);
    throw new Error("No broker operation belongs to pristine fixture");
  };
  const host = new NativeDevelopmentHost({ development }, control, runtime);
  let outcome: NativeHostOutcome | undefined, success = false, original: unknown, launch: Buffer | undefined, phase = "enable";
  const cleanupErrors: string[] = [];
  try {
    expect(await step(() => host.setEnabled(true), 35000, "pristine-enable")).toMatchObject({ ok: true, status: { enabled: true } });
    launch = (await fixed(file, 96)).bytes;
    const decoded = decodeNativeBootstrap(launch), sessionPath = join(control, "native-session.bin");
    const stateBefore = await fixed(sessionPath, 1024), ready = stateBefore.bytes;
    expect(ready.subarray(0, 7).toString("ascii")).toBe("TMCSES1"); expect(ready[7]).toBe(0);
    expect(ready.readUInt32LE(8)).toBe(1); expect(ready.readUInt32LE(12)).toBe(1024); expect(ready.readUInt32LE(16)).toBe(1);
    expect(ready.readUInt32LE(96)).toBe(0); expect(ready.readBigUInt64LE(104)).toBe(0n);
    expect(ready.subarray(992).toString("hex")).toBe(digest(ready.subarray(0, 992)));
    const leasePath = join(control, "native-session.lease"), leaseBefore = await fixed(leasePath, 32);
    const expectedLease = Buffer.alloc(32); expectedLease.write("TMCLEAS1", "ascii"); expectedLease.writeUInt32LE(1, 8); expectedLease.writeUInt32LE(32, 12);
    expect(leaseBefore.bytes).toEqual(expectedLease);
    for (const [offset, path] of [[48, control], [60, join(control, "native-session-reserved")],
      [72, join(control, "native-session-reserved/worker")], [84, leasePath]] as const) {
      const id = await step(() => lstat(path, { bigint: true }), 3000, "pristine-ready-id");
      expect(BigInt(ready.readUInt32LE(offset))).toBe(id.dev);
      expect((BigInt(ready.readUInt32LE(offset + 4)) << 32n) | BigInt(ready.readUInt32LE(offset + 8))).toBe(id.ino);
    }
    expect(ready.readUInt32LE(20)).toBe(decoded.main.pid); expect(ready.readBigUInt64LE(24)).toBe(decoded.main.creationTime);
    expect(ready.subarray(32, 48).toString("hex")).toBe(decoded.ticket.generation);
    expect(ready.subarray(384, 416).toString("hex")).toBe(digest(launch));
    phase = "disable";
    expect(await step(() => host.setEnabled(false), 35000, "pristine-disable")).toMatchObject({ ok: true, status: { enabled: false, connected: false } });
    outcome = await step(() => host.stop(), 3000, "pristine-cached-stop");
    expect(outcome).toEqual({ failed: false, descriptorRemoved: true, helperExitVerified: true, backendRevoked: true,
      listenerClosed: true, brokerCleanupReported: false, reservationCreated: true, reservationReleased: true });
    expect(await host.stop()).toBe(outcome); expect((await host.setEnabled(true)).ok).toBe(false);
    expect(service.status()).toMatchObject({ status: { enabled: false, connected: false } });
    expect(operations).toEqual(["development.configure", "development.status", "development.configure", "development.status"]); expect(engineRuns).toBe(0);
    for (const path of [file, join(control, "native-session-reserved")])
      await expect(step(() => access(path), 3000, "pristine-absent")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await step(() => readdir(control), 3000, "pristine-retained-files")).sort()).toEqual([
      "native-session-release.bin", "native-session-released.bin", "native-session.bin", "native-session.lease",
    ]);
    const stateAfter = await fixed(sessionPath, 1024), leaseAfter = await fixed(leasePath, 32);
    expect(stateAfter.bytes).toEqual(ready); expect(leaseAfter.bytes).toEqual(leaseBefore.bytes);
    for (const key of ["dev", "ino"] as const) { expect(stateAfter.id[key]).toBe(stateBefore.id[key]); expect(leaseAfter.id[key]).toBe(leaseBefore.id[key]); }
    const intentPath = join(control, "native-session-release.bin"), intentRead = await fixed(intentPath, 1024), intent = intentRead.bytes;
    const done = (await fixed(join(control, "native-session-released.bin"), 1024)).bytes;
    for (const [bytes, magic] of [[intent, "TMCRLS1\0"], [done, "TMCRLD1\0"]] as const) {
      expect(bytes.length).toBe(1024); expect(bytes.subarray(0, 8).toString("ascii")).toBe(magic);
      expect(bytes.readUInt32LE(8)).toBe(1); expect(bytes.readUInt32LE(12)).toBe(1024);
      expect(bytes.subarray(992).toString("hex")).toBe(digest(bytes.subarray(0, 992)));
    }
    expect(intent.subarray(16, 48).toString("hex")).toBe(digest(ready));
    expect(intent.readUInt32LE(60)).toBe(decoded.main.pid); expect(intent.readBigUInt64LE(64)).toBe(decoded.main.creationTime);
    expect(intent.subarray(72, 88).toString("hex")).toBe(decoded.ticket.generation);
    expect(intent.subarray(88, 120).toString("hex")).toBe(digest(launch));
    expect(intent.subarray(168, 232).toString("ascii")).toBe(runtime.packageDigest);
    for (const [intentOffset, readyOffset] of [[120, 48], [132, 84], [144, 60], [156, 72]] as const)
      expect(intent.subarray(intentOffset, intentOffset + 12)).toEqual(ready.subarray(readyOffset, readyOffset + 12));
    expect(intent.readUInt32LE(232)).toBe(ready.readUInt32LE(176));
    expect(intent.subarray(236, 236 + intent.readUInt32LE(232))).toEqual(ready.subarray(180, 180 + ready.readUInt32LE(176)));
    const stateId = stateAfter.id, intentId = intentRead.id;
    for (const [offset, id] of [[48, stateId], [908, intentId]] as const) {
      expect(BigInt(intent.readUInt32LE(offset))).toBe(id.dev);
      expect((BigInt(intent.readUInt32LE(offset + 4)) << 32n) | BigInt(intent.readUInt32LE(offset + 8))).toBe(id.ino);
    }
    expect(done.subarray(16, 48).toString("hex")).toBe(digest(intent));
    expect(done.subarray(48, 60)).toEqual(intent.subarray(908, 920));
    expect(done.subarray(60, 72)).toEqual(ready.subarray(48, 60));
    expect(done.subarray(72, 84)).toEqual(ready.subarray(84, 96));
    expect(done.readUInt32LE(84)).toBe(decoded.main.pid); expect(done.readBigUInt64LE(88)).toBe(decoded.main.creationTime);
    expect(done.subarray(96, 112)).toEqual(ready.subarray(32, 48));
    expect(done.subarray(112, 144).toString("hex")).toBe(digest(ready));
    phase = "done"; success = true;
  } catch (error) { original = error; }
  finally {
    try { outcome ??= await bounded(host.stop(), 35000, "pristine-cleanup-stop"); } catch (error) { cleanupErrors.push(String(error)); }
    launch?.fill(0); service.configure(null); assistant.dispose();
    functionalTainted ||= !!original || cleanupErrors.length !== 0 || !success || outcome?.failed !== false;
    const signal = new AbortController(), timer = setTimeout(() => signal.abort(), 3000);
    try { await bounded(writeFile(join(runRoot!, "pristine-functional-result.json"), JSON.stringify({
      success: success && cleanupErrors.length === 0, phase, outcome, operations, engineRunCalls: engineRuns,
      error: original instanceof Error ? original.message : original ? String(original) : null, cleanupErrors,
      scope: "Real Node Host and production release CLI with synthetic in-process backend; no normal broker/worker requested; not independent OS/network/profile/Job proof",
      fixturePreserved: true, rearmAttempted: false, inspectorExecuted: false,
      terminalSuccessRequires: "Passed named Vitest case and actual process exit0 without timeout/cleanup errors; receipt alone is insufficient",
    }, null, 2) + "\n", { flag: "wx", signal: signal.signal }), 3000, "pristine-receipt"); }
    catch (error) { functionalTainted = true; throw error; }
    finally { clearTimeout(timer); }
  }
  if (original) throw original;
  expect(cleanupErrors).toEqual([]); expect(success).toBe(true);
  functionalTainted = false;
}, 130000);
