/** Direct Node integration probe. Run only through an independently reviewed,
 * pinned Windows recipe. It uses the actual compiled Worker, not a test runner's
 * worker teardown. No model, broker operation, network or user data. */
import assert from "node:assert/strict";
import { open, lstat, writeFile } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadNativeLaunchWorkerSupervisor } from "../../../apps/desktop/dist/main/native-launch-worker-port.js";
import { nativeLaunchDeadline } from "../../../apps/desktop/dist/main/native-launch-gate.js";
import { decodeNativeMainIdentity } from "../../../apps/desktop/dist/main/native-main-identity-codec.js";
import { NativeLaunchObservation } from "../../support/mcp/native-launch-observation.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const root = process.env.TAHTIAPURI_NATIVE_LAUNCH_WORKER_RUN_ROOT;
if (process.platform !== "win32" || !root || resolve(root) !== root
  || dirname(root) !== join(project, ".artifacts/tests/native-launch-worker")
  || !/^run-[a-f0-9]{32}$/.test(basename(root))) throw new Error("Pinned Windows worker probe recipe required");

const now = process.hrtime.bigint;
const began = now(), ownerDeadline = began + 55_000_000_000n;
const phaseDeadline = budget => { const cap = now() + budget; return ownerDeadline < cap ? ownerDeadline : cap; };
const events = [], tasks = [], pending = new Map(), controllers = [];
let sequence = 0, firstFailure = null, closing = false, owner;
let overflow = false, completed = 0, nextWork = 0, heartbeatTicks = 0, heartbeatMaxGapMs = 0;
let lastHeartbeat = now();
const heartbeat = setInterval(() => {
  const at = now(); heartbeatMaxGapMs = Math.max(heartbeatMaxGapMs, Number(at - lastHeartbeat) / 1e6);
  lastHeartbeat = at; ++heartbeatTicks;
}, 25);
function mark(stage, detail) {
  if (events.length === 256) { overflow = true; fail("event-overflow"); return; }
  events.push({ order: ++sequence, atNs: String(now() - began), stage, ...(detail ? { detail } : {}) });
}
function fail(reason) {
  if (!firstFailure) firstFailure = { reason, atNs: String(now() - began), order: ++sequence };
}
function alive(deadline) {
  if (closing || firstFailure || now() >= deadline) { fail("original-deadline-or-fence"); throw new Error("Worker probe fenced"); }
}
function track(label, operation) {
  const id = ++nextWork; mark("work-enter", label);
  let original;
  try { original = operation(); }
  catch (error) { fail(label + ":sync-failure"); throw error; }
  const observed = Promise.resolve(original).then(value => {
    pending.delete(id); mark("work-return", label); return value;
  }, error => { pending.delete(id); mark("work-error", label); fail(label + ":rejected"); throw error; });
  pending.set(id, { label, original, observed });
  void observed.catch(() => {}); // The original remains observed after a local timeout.
  return observed;
}
async function until(operation, deadline, label, diagnostic = false) {
  let timer;
  try {
    const remaining = Number(deadline - now()) / 1e6;
    if (remaining <= 0) throw new Error("Worker probe original deadline");
    const result = await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Worker probe observation deadline")), remaining);
    })]);
    if (now() >= deadline) throw new Error("Worker probe late completion");
    return result;
  } catch (error) { if (!diagnostic) fail(label + ":deadline-or-rejection"); throw error; }
  finally { clearTimeout(timer); }
}
async function work(label, operation, deadline) {
  alive(deadline); const value = await until(track(label, operation), deadline, label); alive(deadline); return value;
}
async function absent(path) {
  try { await lstat(path); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  throw new Error("Synthetic control file unexpectedly exists");
}
async function input() {
  const file = await open(join(root, "worker-binding.json"), "r");
  try {
    const before = await file.stat();
    assert(before.isFile() && before.size > 0 && before.size <= 16 * 1024);
    const bytes = Buffer.alloc(before.size + 1); let used = 0;
    while (used < bytes.length) {
      const read = await file.read(bytes, used, bytes.length - used, used);
      if (!read.bytesRead) break; used += read.bytesRead;
    }
    const after = await file.stat();
    for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs"]) assert.equal(before[key], after[key]);
    assert.equal(used, before.size);
    const binding = JSON.parse(bytes.subarray(0, used).toString("utf8"));
    assert.equal(binding.config.controlFile, join(root, "main-bootstrap.bin"));
    // The trusted recipe fixes the package and pins. Own PID is established in
    // this process, rather than imported from a parent or untrusted worker.
    binding.config.pid = process.pid;
    return binding;
  } finally { await file.close(); }
}
async function launch(label, request) {
  // One absolute cap, computed before owner.start/Worker creation. No renewal.
  const deadline = nativeLaunchDeadline(ownerDeadline, now); alive(deadline);
  assert.deepEqual(owner.status(), { pending: false, uncertain: false });
  const controller = new AbortController(); controllers.push(controller);
  const record = { label, task: null, observation: null };
  tasks.push(record); mark("task-enter", label);
  const task = owner.start(request, deadline, controller.signal);
  record.task = task;
  record.observation = new NativeLaunchObservation(task, {
    label, now: () => Number(now() - began) / 1e6, fail, firstFailure: () => structuredClone(firstFailure),
    event: stage => mark(stage, label),
    write: receipt => track("late-" + label + "-diagnostic", () => writeFile(join(root, "late-" + label + ".json"),
      JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" })),
  }); // Both original observations installed before the first await.
  const value = await until(record.observation.result, deadline, label + ":result");
  const final = await until(record.observation.settled, deadline, label + ":settled");
  alive(deadline);
  assert.deepEqual(final, { childCloseObserved: true, workerExited: true, workerExitCode: 0,
    authorityCommitted: request.kind !== "identity", uncertain: false });
  assert.equal(value.authorityCommitted, request.kind !== "identity");
  assert.deepEqual(owner.status(), { pending: false, uncertain: false });
  return value;
}
try {
  const preparationDeadline = phaseDeadline(10_000_000_000n);
  const binding = await work("read-binding", input, preparationDeadline);
  const preparationAbort = new AbortController(); controllers.push(preparationAbort);
  owner = await work("verify-fixed-binding", () => loadNativeLaunchWorkerSupervisor(binding, preparationAbort.signal), preparationDeadline);
  const identity = await launch("identity", { kind: "identity" });
  const parsed = decodeNativeMainIdentity(identity.stdout, process.pid);
  assert.equal(parsed.pid, process.pid); assert.notEqual(parsed.creationTime, 0n); ++completed;
  const fixtureDeadline = phaseDeadline(2_000_000_000n);
  await work("pending-absence", () => absent(join(root, "main-bootstrap.pending")), fixtureDeadline);
  await work("final-absence", () => absent(join(root, "main-bootstrap.bin")), fixtureDeadline);
  await work("pending-create", () => writeFile(join(root, "main-bootstrap.pending"),
    Buffer.from([84, 77, 66, 79, 79, 84, 49, 0]), { flag: "wx" }), fixtureDeadline);
  const recovered = await launch("recover", { kind: "bootstrap", operation: "recover" });
  assert(recovered.stdout.equals(Buffer.from("descriptor-absent\n")));
  const afterDeadline = phaseDeadline(2_000_000_000n);
  // No test unlink: the native helper must have removed this pending fixture.
  await work("native-pending-absent", () => absent(join(root, "main-bootstrap.pending")), afterDeadline);
  await work("native-final-absent", () => absent(join(root, "main-bootstrap.bin")), afterDeadline);
  ++completed;
  await assert.rejects(loadNativeLaunchWorkerSupervisor(binding, new AbortController().signal), /already claimed/);
} catch { fail("probe-operation-or-assertion"); }
finally {
  closing = true; mark("teardown-enter");
  for (const controller of controllers) controller.abort();
  // This separate diagnostic budget cannot extend either native operation's
  // success deadline. It observes only original work; no replacement or kill.
  const drainDeadline = now() + 1_000_000_000n;
  const original = [...pending.values()].map(entry => entry.observed);
  for (const record of tasks) original.push(record.observation?.result, record.observation?.settled);
  try { await until(Promise.allSettled(original.filter(Boolean)), drainDeadline, "drain", true); }
  catch { fail("teardown-unsettled"); }
  clearInterval(heartbeat);
  if (pending.size || tasks.some(record => {
    const snapshot = record.observation?.snapshot(); return !snapshot?.resultSettled || !snapshot?.settlementObserved;
  })) fail("outstanding-original-work");
  const status = owner?.status() ?? null;
  if (!owner || status.pending || status.uncertain) fail("owner-not-clean");
  mark("teardown-observed");
  const passed = !firstFailure && !overflow && completed === 2;
  const report = { schema: 1, passed, firstFailure, completed, pending: [...pending.values()].map(entry => entry.label),
    ownerStatus: status, tasks: tasks.map(record => record.observation?.sealPrimary() ?? {
      label: record.label, resultSettled: false, settlementObserved: false, settlement: null, error: null,
    }),
    heartbeat: { ticks: heartbeatTicks, maxGapMs: heartbeatMaxGapMs,
      scope: "Observed until primary diagnostic drain only; excludes any later Worker lifetime, no worst-case or cause claim" },
    eventsOverflow: overflow, events, forcedWorkerTermination: false, modelExecuted: false,
    brokerOperationExecuted: false, networkRequested: false, automaticRetries: 0 };
  try {
    await until(track("final-diagnostic", () => writeFile(join(root, "worker-result.json"),
      JSON.stringify(report, null, 2) + "\n", { flag: "wx" })), now() + 1_000_000_000n, "final-diagnostic", true);
  } catch { fail("diagnostic-not-confirmed"); }
  if (!passed || firstFailure) process.exitCode = 1;
  // No process.exit/Worker.terminate/unref. A still-owned live Worker keeps this
  // Node process observable to the recipe's separate outer deadline.
}
