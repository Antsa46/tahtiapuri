import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { securePrivateDirectory } from "../../../apps/desktop/src/main/private-directory.js";
import { loadNativeMcpRuntime, type NativeMcpRuntime } from "../../../apps/desktop/src/main/native-mcp-resources.js";
import { encodeNativeBootstrap } from "../../../apps/desktop/src/main/native-development-bootstrap.js";
import { childEnvironment } from "../../../apps/desktop/src/main/child-environment.js";

const traceState = vi.hoisted(() => ({ trace: undefined as ReturnType<typeof import("./native-process-trace.js").createNativeProcessTrace> | undefined }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { createNativeProcessTrace } = await import("./native-process-trace.js");
  traceState.trace = createNativeProcessTrace(); return traceState.trace.wrap(actual);
});
const trace = traceState.trace!;
let traceScope = trace.current(), blockedBeforeStart = false;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureRoot = process.env.TAHTIAPURI_NATIVE_SESSION_RUN_ROOT;
const runtimeRoot = process.env.TAHTIAPURI_NATIVE_MCP_RUNTIME_ROOT;
const descriptor = process.env.TAHTIAPURI_NATIVE_MCP_RUNTIME_DIGEST;
const probe = process.env.TAHTIAPURI_NATIVE_SESSION_PROBE;
const probeDigest = process.env.TAHTIAPURI_NATIVE_SESSION_PROBE_SHA256;
const enabled = process.platform === "win32" && !!fixtureRoot && !!runtimeRoot && !!descriptor && !!probe && !!probeDigest;
const test = enabled ? it : it.skip;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const tick = () => new Promise<void>(done => setTimeout(done, 2));
let runtime: NativeMcpRuntime, end = 0, sequence = 0, tainted = false, rootAdmitted = false, abort = new AbortController();
let peers: Peer[] = [], secrets: Buffer[] = [], pending = new Set<Promise<unknown>>();
const evidence: object[] = [];
function within<T>(work: () => Promise<T>, cap: number, label: string): Promise<T> {
  return trace.within(traceScope, work, cap, label, { end, controller: abort, pending, taint: () => { tainted = true; } });
}
async function cleanupWait(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([work.then(() => true, () => true), new Promise<false>(done => { timer = setTimeout(() => done(false), ms); })]); }
  finally { clearTimeout(timer); }
}
class Peer {
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly lines: string[] = [];
  readonly errors: Buffer[] = [];
  observedClose = false; terminated = false; intentional = false;
  exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private remainder = ""; private output = 0; private errorBytes = 0; private problem: unknown;
  constructor(readonly child: ChildProcessWithoutNullStreams, readonly mode: string) {
    this.closed = new Promise(done => child.once("close", (code, signal) => { this.exit = { code, signal }; this.observedClose = true; done(this.exit); }));
    const failed = (error: unknown) => { this.problem ??= error; };
    child.on("error", failed); child.stdin.on("error", failed); child.stdout.on("error", failed); child.stderr.on("error", failed);
    child.stdout.on("data", (bytes: Buffer) => {
      this.output += bytes.length;
      if (this.output > 256) { failed(new Error("Probe stdout bound")); this.child.kill(); return; }
      this.remainder += bytes.toString("ascii");
      let at: number;
      while ((at = this.remainder.indexOf("\n")) >= 0) {
        this.lines.push(this.remainder.slice(0, at)); this.remainder = this.remainder.slice(at + 1);
        if (this.lines.length > 4) { failed(new Error("Probe line bound")); this.child.kill(); return; }
      }
    });
    child.stderr.on("data", (bytes: Buffer) => {
      this.errorBytes += bytes.length;
      if (this.errorBytes > 256) { failed(new Error("Probe stderr bound")); this.child.kill(); return; }
      this.errors.push(Buffer.from(bytes));
    });
  }
  async line(value: string) {
    await within(async () => {
      while (!this.lines.includes(value)) {
        if (this.problem) throw this.problem;
        if (this.observedClose) throw new Error("Probe closed before " + value);
        await tick();
      }
    }, 7000, "probe-line");
  }
  release(value: "R" | "X" = "R") { this.child.stdin.end(value); }
  async finish(code: number, stage?: string) {
    const exit = await within(() => this.closed, 7500, "probe-exit");
    expect(exit).toEqual({ code, signal: null }); expect(this.problem).toBeUndefined(); expect(this.remainder).toBe("");
    const stderr = Buffer.concat(this.errors).toString("utf8");
    if (stage) expect(JSON.parse(stderr).stage).toBe(stage); else expect(stderr).toBe("");
    return exit;
  }
  async stop(intentional = false) {
    if (this.observedClose) {
      if (intentional) throw new Error("Intentional interruption target already closed");
      return;
    }
    if (intentional && (this.child.exitCode !== null || this.child.signalCode !== null)) throw new Error("Interruption target is no longer live");
    this.terminated = true; this.intentional = intentional;
    if (!this.child.kill() && intentional) throw new Error("Intentional interruption was not delivered");
    if (!await cleanupWait(this.closed, 2500)) throw new Error("Owned probe exit unobserved");
    if (intentional) {
      const exit = await this.closed;
      expect(exit.code !== 0 || exit.signal !== null).toBe(true);
    }
  }
}
async function verifyProbe() {
  expect(basename(probe!)).toBe("session-gate.exe"); expect(probeDigest).toMatch(/^[a-f0-9]{64}$/);
  let path = probe!;
  for (;;) {
    const info = await within(() => lstat(path), 3000, "probe-path");
    expect(info.isSymbolicLink()).toBe(false);
    const parent = dirname(path); if (parent === path) break; path = parent;
  }
  const before = await within(() => lstat(probe!), 3000, "probe-stat");
  expect(before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= 4194304).toBe(true);
  expect(hash(await within(() => readFile(probe!), 3000, "probe-hash"))).toBe(probeDigest);
  const after = await within(() => lstat(probe!), 3000, "probe-restat");
  for (const key of ["dev", "ino", "size", "nlink", "mtimeMs", "ctimeMs"] as const) expect(after[key]).toBe(before[key]);
}
type Fixture = { directory: string; control: string; file: string; reservation: string; session: string; lease: string; bytes: Buffer };
async function actor(mode: string, f: Fixture): Promise<Peer> {
  await verifyProbe();
  if (performance.now() >= end) throw new Error("No probe spawn after deadline");
  const peer = new Peer(spawn(probe!, ["--" + mode, f.file], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: childEnvironment(process.env) }), mode);
  peers.push(peer);
  if (mode === "admit-hold") return peer;
  if (mode === "protect-session") { peer.child.stdin.end(); return peer; }
  const input = Buffer.from(f.bytes);
  if (mode === "publish-hold") peer.child.stdin.write(input, () => input.fill(0));
  else peer.child.stdin.end(input, () => input.fill(0));
  return peer;
}
async function run(mode: string, f: Fixture, code = 0, stage?: string) {
  const peer = await actor(mode, f); await peer.finish(code, stage); return peer;
}
async function fixture(prepare = true, ready = false): Promise<Fixture> {
  const directory = join(fixtureRoot!, "c" + String(++sequence).padStart(3, "0")), control = join(directory, "control");
  await within(() => mkdir(directory), 3000, "case-root");
  await within(() => securePrivateDirectory(control, abort.signal), 13000, "private-control");
  const reservation = join(control, "native-session-reserved"); await within(() => mkdir(reservation), 3000, "reservation");
  const main = await within(() => runtime.helpers.identity(abort.signal), 6000, "identity");
  const bytes = encodeNativeBootstrap({ main, pipeNonce: randomBytes(16).toString("hex"),
    ticket: { generation: randomBytes(16).toString("hex"), token: randomBytes(32).toString("hex") } }); secrets.push(bytes);
  const f = { directory, control, file: join(control, "main-bootstrap.bin"), reservation, session: join(control, "native-session.bin"), lease: join(control, "native-session.lease"), bytes };
  if (prepare) await run("prepare", f);
  if (ready) {
    await within(() => runtime.prepareWorker(reservation, abort.signal), 32000, "stage");
    await run("seal", f);
  }
  return f;
}
const read = (path: string) => within(() => readFile(path), 3000, "read-fixture");
const absent = async (path: string) => expect(within(() => access(path), 3000, "absent-fixture")).rejects.toMatchObject({ code: "ENOENT" });
beforeAll(async () => {
  if (!enabled) return;
  end = performance.now() + 30000;
  expect(resolve(fixtureRoot!)).toBe(fixtureRoot);
  expect(dirname(fixtureRoot!)).toBe(join(root, ".artifacts/tests/native-mcp-session-gates"));
  expect(basename(fixtureRoot!)).toMatch(/^run-[a-f0-9]{32}$/);
  expect(dirname(dirname(probe!))).toBe(join(root, ".artifacts/tests/t09an-mcp-session"));
  expect(basename(dirname(probe!))).toMatch(/^probe-build-[a-f0-9]{32}$/);
  const marker = await within(() => readFile(join(fixtureRoot!, "owner.marker"), "utf8"), 3000, "run-owner-marker");
  expect(marker).toBe("TAHTIAPURI_NATIVE_SESSION_GATE_RUN_V1\n"); rootAdmitted = true;
  await verifyProbe();
  runtime = await within(() => loadNativeMcpRuntime({ runtimeRoot: runtimeRoot!, descriptorSha256: descriptor! }, abort.signal), 15000, "runtime-package");
}, 35000);
beforeEach(() => {
  if (!enabled) return;
  peers = []; secrets = []; traceScope = trace.begin(); blockedBeforeStart = tainted;
  if (blockedBeforeStart) throw new Error("Earlier case has uncertain ownership");
  end = performance.now() + 45000; abort = new AbortController();
});
afterEach(async context => {
  if (!enabled) return;
  const scope = traceScope;
  trace.note(scope, "abort-request", "case-cleanup");
  if (!blockedBeforeStart) abort.abort();
  const unexpected = peers.filter(peer => !peer.observedClose && !peer.intentional);
  const failures: string[] = [];
  for (const peer of peers) { try { await peer.stop(); } catch (error) { failures.push(String(error)); } }
  if (!await cleanupWait(Promise.allSettled([...pending]), 5000)) failures.push("Unsettled owned operation");
  // Generic helper promises may settle before actual child.close. Observe and
  // clean up only handles owned by this case; never search or kill by name/PID.
  const helpers = trace.children(scope).filter(owned => !peers.some(peer => peer.child === owned.child));
  for (const owned of helpers) {
    if (owned.record.observedClose) continue;
    tainted = true;
    try { owned.child.kill(); } catch { failures.push("Owned helper termination failed"); }
    if (!await cleanupWait(owned.closed, 2500) || !owned.record.observedClose) failures.push("Owned helper exit unobserved");
  }
  if (scope.uncertain || scope.overflow) tainted = true;
  for (const bytes of secrets) bytes.fill(0);
  if (unexpected.length || failures.length) tainted = true;
  evidence.push({ name: context.task.name, state: context.task.result?.state ?? "unknown",
    peers: peers.map(peer => ({ pid: peer.child.pid, mode: peer.mode, observedClose: peer.observedClose, exit: peer.exit ?? null, terminated: peer.terminated, intentional: peer.intentional })),
    unexpectedLive: unexpected.length, cleanupErrors: failures, blockedBeforeStart,
    trace: scope, children: trace.records(scope) });
  expect(failures).toEqual([]); expect(unexpected).toEqual([]);
});
afterAll(async () => {
  if (!enabled || !rootAdmitted) return;
  const record = { cases: evidence, tainted, probeBinarySha256: probeDigest, fixturePreserved: true,
    scope: "Production session functions in a nonpackaged owner probe; no normal broker HELLO/worker or independent OS/network acceptance",
    workerExecuted: false, profileCreated: false, jobCreated: false, inspectorExecuted: false };
  const signal = AbortSignal.timeout(3000);
  await writeFile(join(fixtureRoot!, "gate-evidence.json"), JSON.stringify(record, null, 2) + "\n", { flag: "wx", signal });
});

test("fixed order and duplicate preparation preserve the bound state", async () => {
  const f = await fixture(), before = await read(f.session);
  await run("prepare", f, 1, "mcp-session-lease-open");
  expect(await read(f.session)).toEqual(before);
  await run("publish", f, 1, "mcp-session-publish-order");
  expect(await read(f.session)).toEqual(before); await absent(f.file);
});
test("seal without preparation creates no state", async () => {
  const f = await fixture(false); await run("seal", f, 1, "mcp-session-lease-open");
  await absent(f.lease); await absent(f.session); await absent(f.file);
});
test("a missing stage stays PREPARING", async () => {
  const f = await fixture(), before = await read(f.session); await run("seal", f, 1, "mcp-tree-shape");
  expect(await read(f.session)).toEqual(before); await absent(f.file);
});
test.each(["empty-lease", "lease-header", "short-session", "long-session", "checksum", "version", "acl"] as const)("preserves rejected persisted state: %s", async mutation => {
  const f = await fixture();
  if (mutation === "empty-lease") await within(() => writeFile(f.lease, Buffer.alloc(0)), 3000, "truncate-lease");
  else if (mutation === "lease-header") {
    const data = await read(f.lease); data[0] = data[0]! ^ 1;
    await within(() => writeFile(f.lease, data), 3000, "corrupt-lease-header");
  } else if (mutation === "acl") await run("protect-session", f);
  else {
    let data = await read(f.session);
    if (mutation === "short-session") data = data.subarray(0, 256);
    if (mutation === "long-session") data = Buffer.concat([data, Buffer.alloc(1)]);
    if (mutation === "checksum") data[1000] = data[1000]! ^ 1;
    if (mutation === "version") { data.writeUInt32LE(2, 8); createHash("sha256").update(data.subarray(0, 992)).digest().copy(data, 992); }
    await within(() => writeFile(f.session, data), 3000, "corrupt-session");
  }
  const before = await read(f.session), lease = await read(f.lease);
  const expected = mutation === "empty-lease" || mutation === "short-session" || mutation === "long-session" ? "mcp-session-length"
    : mutation === "lease-header" ? "mcp-session-lease-header" : mutation === "checksum" ? "mcp-session-checksum" : mutation === "version" ? "mcp-session-format" : "bootstrap-dacl";
  await run("seal", f, 1, expected);
  expect(await read(f.session)).toEqual(before); expect(await read(f.lease)).toEqual(lease); await absent(f.file);
});
test.each(["descriptor", "generation", "lease", "reservation", "control"] as const)("rejects changed binding before sealing: %s", async mutation => {
  const f = await fixture(), before = await read(f.session);
  if (mutation === "descriptor") f.bytes[32] = f.bytes[32]! ^ 1;
  if (mutation === "generation") f.bytes[48] = f.bytes[48]! ^ 1;
  if (mutation === "lease") {
    const bytes = await read(f.lease); await within(() => rename(f.lease, join(f.directory, "old-lease")), 3000, "move-lease");
    await within(() => writeFile(f.lease, bytes, { flag: "wx" }), 3000, "replace-lease");
  }
  if (mutation === "reservation") {
    await within(() => rename(f.reservation, join(f.directory, "old-reservation")), 3000, "move-reservation");
    await within(() => mkdir(f.reservation), 3000, "replace-reservation");
  }
  if (mutation === "control") {
    const old = join(f.directory, "old-control");
    await within(() => rename(f.control, old), 3000, "move-control");
    await within(() => securePrivateDirectory(f.control, abort.signal), 13000, "replace-control");
    for (const name of ["native-session.lease", "native-session.bin", "native-session-reserved"])
      await within(() => rename(join(old, name), join(f.control, name)), 3000, "move-control-child");
  }
  await run("seal", f, 1, mutation === "reservation" ? "mcp-session-reservation" : "mcp-session-context");
  expect(await read(f.session)).toEqual(before); await absent(f.file);
});
test("READY seals once, publishes, admits once, and refuses ADMITTED reuse", async () => {
  const f = await fixture(true, true), ready = await read(f.session);
  await run("seal", f, 1, "mcp-session-seal-order"); expect(await read(f.session)).toEqual(ready);
  await run("publish", f);
  const admitted = await actor("admit-hold", f); await admitted.line("admitted"); admitted.release(); await admitted.finish(0);
  const state = await read(f.session); expect(state.readUInt32LE(16)).toBe(2); expect(state.readUInt32LE(96)).toBe(admitted.child.pid);
  expect(state.subarray(384, 416).toString("hex")).toBe(hash(f.bytes));
  const duplicate = await actor("admit-hold", f); duplicate.child.stdin.end(); await duplicate.finish(1, "mcp-session-admission-order");
  expect(await read(f.session)).toEqual(state); await absent(join(f.reservation, "broker-journal.bin"));
}, 60000);
test("changed READY stage identity refuses publication", async () => {
  const f = await fixture(true, true), ready = await read(f.session);
  await within(() => rename(join(f.reservation, "worker"), join(f.directory, "old-worker")), 3000, "move-stage");
  await within(() => runtime.prepareWorker(f.reservation, abort.signal), 32000, "replace-stage");
  await run("publish", f, 1, "mcp-session-stage");
  expect(await read(f.session)).toEqual(ready); await absent(f.file);
}, 60000);
test("publisher holds the real lease until descriptor close and release permits admission", async () => {
  const f = await fixture(true, true);
  const publisher = await actor("publish-hold", f); await publisher.line("published-held");
  expect(await read(f.file)).toEqual(f.bytes);
  await expect(within(() => readFile(f.lease), 3000, "locked-lease")).rejects.toMatchObject({ code: "EBUSY" });
  const admitted = await actor("admit-hold", f); await admitted.line("admission-starting"); await tick();
  expect(admitted.lines).not.toContain("admitted"); expect(admitted.observedClose).toBe(false);
  publisher.release(); await publisher.finish(0);
  await admitted.line("admitted"); admitted.release(); await admitted.finish(0);
  expect((await read(f.session)).readUInt32LE(16)).toBe(2);
}, 60000);
test("lease deadline retains READY and rejects admission", async () => {
  const f = await fixture(true, true), ready = await read(f.session);
  const publisher = await actor("publish-hold", f); await publisher.line("published-held");
  const admitted = await actor("admit-hold", f); await admitted.line("admission-starting");
  await admitted.finish(1, "mcp-session-lease-timeout"); expect(admitted.lines).not.toContain("admitted");
  publisher.release(); await publisher.finish(0);
  expect(await read(f.session)).toEqual(ready); await absent(join(f.reservation, "broker-journal.bin"));
}, 60000);
test("generic consume completes while the publisher still owns the session lease", async () => {
  const f = await fixture(true, true), ready = await read(f.session);
  const publisher = await actor("publish-hold", f); await publisher.line("published-held");
  await within(() => runtime.helpers.operate("consume", f.file, f.bytes, abort.signal), 7000, "consume-under-lease");
  await absent(f.file); expect(publisher.observedClose).toBe(false);
  publisher.release(); await publisher.finish(0); expect(await read(f.session)).toEqual(ready);
}, 60000);
test("publisher callback failure preserves the published descriptor and READY", async () => {
  const f = await fixture(true, true), ready = await read(f.session);
  const publisher = await actor("publish-hold", f); await publisher.line("published-held"); publisher.release("X");
  await publisher.finish(1, "session-probe-interrupted");
  expect(await read(f.file)).toEqual(f.bytes); expect(await read(f.session)).toEqual(ready);
}, 60000);
test("owned publisher interruption preserves descriptor and READY", async () => {
  const f = await fixture(true, true), ready = await read(f.session);
  const publisher = await actor("publish-hold", f); await publisher.line("published-held"); await publisher.stop(true);
  expect(publisher.observedClose).toBe(true);
  expect(await read(f.file)).toEqual(f.bytes); expect(await read(f.session)).toEqual(ready);
}, 60000);
