import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, copyFile, link, lstat, mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
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
function within<T>(work: (deadline: number) => Promise<T>, cap: number, label: string): Promise<T> {
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
  if (performance.now() >= end) { tainted = true; await peer.stop(); throw new Error("Probe returned after case deadline"); }
  if (mode === "admit-hold" || mode === "admit-after-read" || mode.startsWith("hold-")) return peer;
  if (mode.startsWith("protect-")) { peer.child.stdin.end(); return peer; }
  const input = Buffer.from(f.bytes);
  if (mode === "publish-hold" || mode.startsWith("release-hold-")) peer.child.stdin.write(input, () => input.fill(0));
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
  expect(dirname(dirname(probe!))).toBe(join(root, ".artifacts/tests/t09ao-mcp-release-pristine"));
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
  expect(scope.overflow).toBe(false); expect(scope.uncertain).toBe(false);
});
afterAll(async () => {
  if (!enabled || !rootAdmitted) return;
  const record = { cases: evidence, tainted, probeBinarySha256: probeDigest, fixturePreserved: true,
    scope: "Session/release owner probe: held barriers use20s and ordinary calls5s; not production-host or independent OS/network acceptance",
    releaseTargetCount: 13, barrierBudgetMs: 20000, ordinaryProbeBudgetMs: 5000, normalBrokerExecuted: false,
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
  await within(deadline => runtime.helpers.operate("consume", f.file, f.bytes, abort.signal, deadline), 7000, "consume-under-lease");
  const budget = traceScope.events.find(event => event.event === "operation-requested" && event.operation === "consume-under-lease");
  const dispatched = traceScope.events.filter(event => event.event === "stdin-end-enter" && event.operation === "main-bootstrap.exe--consume");
  expect(budget?.deadlineMs).toBeDefined(); expect(dispatched).toHaveLength(1);
  expect(dispatched[0]!.atMs).toBeLessThan(budget!.deadlineMs!);
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

// Release is a fixed inventory, not a recursive filesystem cleanup. Snapshot
// helpers retain only identities/sizes, never package bytes or ticket contents.
const intentFile = (f: Fixture) => join(f.control, "native-session-release.bin");
const completedFile = (f: Fixture) => join(f.control, "native-session-released.bin");
function releasePaths(f: Fixture) {
  const worker = join(f.reservation, "worker"), pkg = join(worker, "package");
  return [
    ...["licenses/mcp-core-LICENSE.txt", "licenses/mcp-server-LICENSE.txt", "licenses/node-LICENSE.txt", "licenses/zod-LICENSE.txt",
      "mcp-worker.mjs", "node.exe", "package.json", "runtime-manifest.json"].map(name => join(pkg, name)),
    join(pkg, "licenses"), pkg, join(worker, "scratch"), worker, f.reservation,
  ];
}
async function releaseSnapshot(f: Fixture) {
  const rows = [];
  for (const path of releasePaths(f)) {
    try {
      const value = await within(() => lstat(path, { bigint: true }), 3000, "release-target-stat");
      rows.push({ present: true, volume: value.dev.toString(), id: value.ino.toString(), bytes: value.size.toString() });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      rows.push({ present: false });
    }
  }
  return rows;
}
async function verifiedReleaseIntent(f: Fixture, ready: Buffer) {
  const intent = await read(intentFile(f));
  expect(intent.length).toBe(1024); expect(intent.subarray(0, 8).toString("ascii")).toBe("TMCRLS1\0");
  expect(intent.subarray(992).toString("hex")).toBe(hash(intent.subarray(0, 992)));
  expect(intent.subarray(16, 48).toString("hex")).toBe(hash(ready));
  expect(intent.readUInt32LE(60)).toBe(ready.readUInt32LE(20));
  expect(intent.readBigUInt64LE(64)).toBe(ready.readBigUInt64LE(24));
  for (const [intentOffset, readyOffset, length] of [[72, 32, 16], [88, 384, 32], [120, 48, 12],
    [132, 84, 12], [144, 60, 12], [156, 72, 12], [168, 112, 64]] as const)
    expect(intent.subarray(intentOffset, intentOffset + length)).toEqual(ready.subarray(readyOffset, readyOffset + length));
  expect(intent.readUInt32LE(232)).toBe(ready.readUInt32LE(176));
  expect(intent.subarray(236, 236 + intent.readUInt32LE(232))).toEqual(ready.subarray(180, 180 + ready.readUInt32LE(176)));
  const stateId = await within(() => lstat(f.session, { bigint: true }), 3000, "release-session-id");
  const intentId = await within(() => lstat(intentFile(f), { bigint: true }), 3000, "release-intent-id");
  for (const [offset, value] of [[48, stateId], [908, intentId]] as const) {
    expect(BigInt(intent.readUInt32LE(offset))).toBe(value.dev);
    expect((BigInt(intent.readUInt32LE(offset + 4)) << 32n) | BigInt(intent.readUInt32LE(offset + 8))).toBe(value.ino);
  }
  return intent;
}
async function released(f: Fixture, ready: Buffer) {
  await absent(f.reservation); expect(await read(f.session)).toEqual(ready);
  expect((await within(() => readdir(f.control), 3000, "released-control")).sort()).toEqual([
    "native-session-release.bin", "native-session-released.bin", "native-session.bin", "native-session.lease",
  ]);
  const intent = await verifiedReleaseIntent(f, ready), done = await read(completedFile(f));
  expect(intent.length).toBe(1024); expect(done.length).toBe(1024);
  expect(intent.subarray(0, 8).toString("ascii")).toBe("TMCRLS1\0");
  expect(done.subarray(0, 8).toString("ascii")).toBe("TMCRLD1\0");
  expect(intent.subarray(992).toString("hex")).toBe(hash(intent.subarray(0, 992)));
  expect(done.subarray(992).toString("hex")).toBe(hash(done.subarray(0, 992)));
  expect(intent.subarray(16, 48).toString("hex")).toBe(hash(ready));
  expect(done.subarray(16, 48).toString("hex")).toBe(hash(intent));
  expect(done.subarray(112, 144).toString("hex")).toBe(hash(ready));
  const original = await within(() => lstat(intentFile(f), { bigint: true }), 3000, "intent-id");
  expect(BigInt(intent.readUInt32LE(908))).toBe(original.dev);
  expect((BigInt(intent.readUInt32LE(912)) << 32n) | BigInt(intent.readUInt32LE(916))).toBe(original.ino);
  expect(done.subarray(48, 60)).toEqual(intent.subarray(908, 920));
}
async function interruptedRelease(f: Fixture, frontier: number) {
  const held = await actor("release-hold-" + frontier, f); await held.line("release-held"); await held.stop(true);
  return held;
}
async function releaseSuccess(f: Fixture) {
  const peer = await run("release-pristine", f); expect(peer.lines).toEqual(["session-released"]); return peer;
}
test("pristine release removes the fixed inventory and acknowledges the same completed release", async () => {
  const f = await fixture(true, true), ready = await read(f.session);
  await releaseSuccess(f); await released(f, ready);
  const intent = await read(intentFile(f)), completion = await read(completedFile(f));
  await releaseSuccess(f); await released(f, ready);
  expect(await read(intentFile(f))).toEqual(intent); expect(await read(completedFile(f))).toEqual(completion);
}, 60000);
test.each(Array.from({ length: 14 }, (_, index) => index))("pristine interruption resumes only its fixed removed prefix: %s", async frontier => {
  const f = await fixture(true, true), ready = await read(f.session);
  await interruptedRelease(f, frontier); await absent(completedFile(f));
  const snapshot = await releaseSnapshot(f);
  expect(snapshot.map(value => value.present)).toEqual(Array.from({ length: 13 }, (_, index) => index >= frontier));
  const intent = await read(intentFile(f)); expect(intent.length).toBe(1024);
  await releaseSuccess(f); await released(f, ready); expect(await read(intentFile(f))).toEqual(intent);
}, 60000);
const recordFaults = (["intent", "completion"] as const).flatMap(kind =>
  (["write", "short-write", "flush", "read", "short-read", "readback"] as const).map(fault => [kind, fault] as const));
test.each(recordFaults)("record I/O failure preserves the exact stopped state: %s %s", async (kind, fault) => {
  const f = await fixture(true, true), ready = await read(f.session), before = await releaseSnapshot(f);
  const stage = { write: "mcp-release-write", "short-write": "mcp-release-write-count", flush: "mcp-release-flush",
    read: "mcp-release-read", "short-read": "mcp-release-read-count", readback: "mcp-release-readback" }[fault];
  const failed = await run("release-" + kind + "-" + fault, f, 1, stage);
  expect(failed.lines).not.toContain("session-released"); expect(await read(f.session)).toEqual(ready);
  const snapshot = await releaseSnapshot(f);
  if (kind === "intent") {
    expect(snapshot).toEqual(before); await absent(completedFile(f));
  } else expect(snapshot.map(value => value.present)).toEqual(Array(13).fill(false));
  const file = kind === "intent" ? intentFile(f) : completedFile(f);
  const bytes = await read(file); expect(bytes.length).toBe(fault === "write" ? 0 : fault === "short-write" ? 16 : 1024);
  if (fault === "write" || fault === "short-write") {
    await run("release-pristine", f, 1, "mcp-release-record-length");
    expect(await read(file)).toEqual(bytes); expect(await releaseSnapshot(f)).toEqual(snapshot);
  } else {
    await releaseSuccess(f); await released(f, ready); expect(await read(file)).toEqual(bytes);
  }
}, 60000);
test("a reader denying delete sharing prevents intent creation and every deletion", async () => {
  const f = await fixture(true, true), ready = await read(f.session), before = await releaseSnapshot(f);
  const reader = await actor("hold-deny-delete", f); await reader.line("reader-held");
  await run("release-pristine", f, 1, "bootstrap-open");
  expect(await releaseSnapshot(f)).toEqual(before); await absent(intentFile(f)); await absent(completedFile(f));
  reader.release(); await reader.finish(0); await releaseSuccess(f); await released(f, ready);
}, 60000);
test.each(["hold-reader", "hold-metadata"] as const)("delete-pending uncertainty prevents completion while %s remains open", async mode => {
  const f = await fixture(true, true), ready = await read(f.session), before = await releaseSnapshot(f);
  const reader = await actor(mode, f); await reader.line("reader-held");
  const failed = await actor("release-pristine", f), exit = await within(() => failed.closed, 7500, "pending-release-exit");
  expect(exit).toEqual({ code: 1, signal: null }); expect(failed.observedClose).toBe(true);
  const diagnostic = JSON.parse(Buffer.concat(failed.errors).toString("utf8")) as { stage: string; code: number };
  expect(["bootstrap-still-present", "bootstrap-absence-uncertain"]).toContain(diagnostic.stage);
  expect(Number.isInteger(diagnostic.code) && diagnostic.code > 0).toBe(true);
  await failed.finish(1, diagnostic.stage);
  expect(failed.lines).not.toContain("session-released"); await absent(completedFile(f)); expect(await read(f.session)).toEqual(ready);
  const intent = await verifiedReleaseIntent(f, ready);
  // The first link may be delete-pending, so do not treat a failed lstat as
  // absence. Every later target must retain its original identity and size.
  for (let index = 1; index < releasePaths(f).length; ++index) {
    const value = await within(() => lstat(releasePaths(f)[index]!, { bigint: true }), 3000, "pending-survivor");
    expect({ present: true, volume: value.dev.toString(), id: value.ino.toString(), bytes: value.size.toString() }).toEqual(before[index]);
  }
  reader.release(); await reader.finish(0); expect(reader.lines).toEqual(["reader-held", "reader-complete"]);
  // This disappearance must precede the retry: an unrelated pre-delete error
  // would leave target0 present after the reader closes.
  await absent(releasePaths(f)[0]!); expect(await read(intentFile(f))).toEqual(intent);
  await releaseSuccess(f); await released(f, ready);
}, 60000);

test.each(["intent-identity", "intent-corrupt", "target-identity", "target-content", "nonprefix-hole",
  "extra-file", "reparse", "hardlink", "intent-acl", "target-acl"] as const)("a changed release inventory stays untouched: %s", async mutation => {
  const f = await fixture(true, true), ready = await read(f.session);
  await interruptedRelease(f, 0); const targets = releasePaths(f);
  if (mutation === "intent-identity") {
    const old = join(f.directory, "old-intent");
    await within(() => rename(intentFile(f), old), 3000, "move-intent");
    await within(() => copyFile(old, intentFile(f)), 3000, "replace-intent");
  } else if (mutation === "intent-corrupt") {
    const bytes = await read(intentFile(f)); bytes[1000] = bytes[1000]! ^ 1;
    await within(() => writeFile(intentFile(f), bytes), 3000, "corrupt-intent");
  } else if (mutation === "target-identity") {
    const old = join(f.directory, "old-target");
    await within(() => rename(targets[0]!, old), 3000, "move-target");
    await within(() => copyFile(old, targets[0]!), 3000, "replace-target");
  } else if (mutation === "target-content") await within(() => writeFile(targets[0]!, "changed fixture bytes"), 3000, "change-target");
  else if (mutation === "nonprefix-hole") await within(() => unlink(targets[1]!), 3000, "nonprefix-hole");
  else if (mutation === "extra-file") await within(() => writeFile(join(targets[9]!, "extra.txt"), "synthetic"), 3000, "extra-file");
  else if (mutation === "reparse") {
    const old = join(f.directory, "old-licenses");
    await within(() => rename(targets[8]!, old), 3000, "move-licenses");
    await within(() => symlink(old, targets[8]!, "junction"), 3000, "junction-licenses");
  } else if (mutation === "hardlink") await within(() => link(targets[0]!, join(f.directory, "extra-link")), 3000, "hardlink-target");
  else await run(mutation === "intent-acl" ? "protect-intent" : "protect-target", f);
  const before = await releaseSnapshot(f), intent = await read(intentFile(f));
  const stage = {
    "intent-identity": "mcp-release-intent-context", "intent-corrupt": "mcp-release-checksum",
    "target-identity": "mcp-release-target-binding", "target-content": "mcp-pin-size",
    "nonprefix-hole": "mcp-release-nonprefix", "extra-file": "mcp-tree-shape", reparse: "mcp-release-reparse",
    hardlink: "bootstrap-file-type", "intent-acl": "bootstrap-dacl", "target-acl": "mcp-acl-policy",
  }[mutation];
  await run("release-pristine", f, 1, stage);
  expect(await releaseSnapshot(f)).toEqual(before); expect(await read(intentFile(f))).toEqual(intent);
  expect(await read(f.session)).toEqual(ready); await absent(completedFile(f));
  // Any release entry fences the old generation, even when malformed. Prepare
  // must reject before CREATE_NEW can mutate the fixed existing lease.
  for (const mode of ["prepare", "seal", "publish"]) await run(mode, f, 1, "mcp-session-release-present");
  expect(await releaseSnapshot(f)).toEqual(before);
}, 60000);
test("an orphan completion blocks release and every old owner mode", async () => {
  const f = await fixture(true, true), ready = await read(f.session), before = await releaseSnapshot(f);
  await within(() => writeFile(completedFile(f), Buffer.alloc(0), { flag: "wx" }), 3000, "orphan-completion");
  await run("release-pristine", f, 1, "mcp-release-orphan-completion");
  for (const mode of ["prepare", "seal", "publish"]) await run(mode, f, 1, "mcp-session-release-present");
  expect(await releaseSnapshot(f)).toEqual(before); expect(await read(f.session)).toEqual(ready); await absent(intentFile(f));
}, 60000);
test("a release intent fences a broker which already read the old descriptor", async () => {
  const f = await fixture(true, true), ready = await read(f.session); await run("publish", f);
  const candidate = await actor("admit-after-read", f); await candidate.line("descriptor-read");
  await within(deadline => runtime.helpers.operate("consume", f.file, f.bytes, abort.signal, deadline), 7000, "consume-before-release");
  const publisher = await actor("release-hold-0", f); await publisher.line("release-held");
  candidate.release(); await candidate.line("admission-starting"); expect(candidate.lines).not.toContain("admitted");
  publisher.release(); await publisher.finish(0); expect(publisher.lines).toEqual(["release-held", "session-released"]);
  await candidate.finish(1, "mcp-session-release-present"); expect(candidate.lines).not.toContain("admitted");
  await released(f, ready);
}, 60000);
test("a broker winning admission prevents pristine release before and after its exit", async () => {
  const f = await fixture(true, true); await run("publish", f);
  const admitted = await actor("admit-hold", f); await admitted.line("admitted");
  await within(deadline => runtime.helpers.operate("consume", f.file, f.bytes, abort.signal, deadline), 7000, "consume-admitted-descriptor");
  const before = await releaseSnapshot(f);
  await run("release-pristine", f, 1, "mcp-session-lease-open");
  await absent(intentFile(f)); await absent(completedFile(f)); expect(await releaseSnapshot(f)).toEqual(before);
  admitted.release(); await admitted.finish(0); const record = await read(f.session); expect(record.readUInt32LE(16)).toBe(2);
  await run("release-pristine", f, 1, "mcp-release-not-pristine");
  expect(await releaseSnapshot(f)).toEqual(before); expect(await read(f.session)).toEqual(record); await absent(intentFile(f));
}, 60000);
