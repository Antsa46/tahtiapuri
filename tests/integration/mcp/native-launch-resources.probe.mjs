/** Direct Node probe for the fixed compiled resource factory. Only a reviewed
 * pinned recipe may run it. One directory grant and two synthetic helper calls; no broker/model/API. */
import assert from "node:assert/strict";
import { open, lstat, realpath, writeFile } from "node:fs/promises";
import { dirname, basename, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadNativeLaunchMcpResources } from "../../../apps/desktop/dist/main/native-launch-mcp-resources.js";
import { NativeLaunchObservation } from "../../support/mcp/native-launch-observation.mjs";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const root = process.env.TAHTIAPURI_NATIVE_LAUNCH_RESOURCES_RUN_ROOT;
if (process.platform !== "win32" || !root || resolve(root) !== root
  || dirname(root) !== join(project, ".artifacts/tests/native-launch-resources")
  || !/^run-[a-f0-9]{32}$/.test(basename(root))) throw new Error("Pinned Windows resource probe recipe required");
const control = join(root, "control");
const now = process.hrtime.bigint, began = now(), ownerDeadline = performance.now() + 75_000;
const phaseDeadline = budget => Math.min(ownerDeadline, performance.now() + budget);
const events = [], calls = [], pending = new Map(), controllers = [];
let sequence = 0, nextWork = 0, firstFailure = null, closing = false, primarySealed = false;
let owner, preparationRequested = false, preparationReturned = false, completed = 0, overflow = false;
let systemPowerShellVerified = false;
// Retain Main while original preparation or child/Worker ownership is unknown.
// The outer reviewed owner can stop this owned tree; no Worker is terminated,
// reset, unrefed or replaced to regain progress. A late close never upgrades failure.
const quiescenceGuard = setInterval(() => {
  if (!primarySealed || pending.size || preparationRequested && !preparationReturned || owner?.status().pending) return;
  if (calls.some(record => !record.resultSettled || !record.observationFinished)) return;
  const physical = calls.every(record => {
    const native = record.nativeWatcher?.snapshot();
    if (native?.settlementObserved) return native.settlement.childCloseObserved === true && native.settlement.workerExited === true;
    return ["none", "no-task"].includes(record.nativeBinding) && record.originalOutcome?.status === "rejected" && record.error?.exitVerified === true;
  });
  if (physical) clearInterval(quiescenceGuard); // Failed primary still exits1.
}, 25);
function fail(reason) { if (!firstFailure) firstFailure = { reason, order: ++sequence, atNs: String(now() - began) }; }
function mark(stage, label) {
  if (events.length >= 256) { overflow = true; fail("event-overflow"); return; }
  events.push({ order: ++sequence, atNs: String(now() - began), stage, ...(label ? { label } : {}) });
}
const errorInfo = error => ({ name: error?.name ?? "Error", code: error?.code ?? null,
  exitVerified: error?.exitVerified ?? null, authorityCommitted: error?.authorityCommitted ?? null });
function alive(deadline) {
  if (closing || firstFailure || performance.now() >= deadline) { fail("original-deadline-or-fence"); throw new Error("Resource probe fenced"); }
}
function track(label, operation) {
  const id = ++nextWork; mark("work-enter", label); let original;
  try { original = operation(); } catch (error) { fail(label + ":sync-failure"); throw error; }
  const observed = Promise.resolve(original).then(value => {
    pending.delete(id); mark("work-return", label); return value;
  }, error => { pending.delete(id); mark("work-error", label); fail(label + ":rejected"); throw error; });
  pending.set(id, { label, original, observed }); void observed.catch(() => {}); return observed;
}
async function until(operation, deadline, label, diagnostic = false) {
  let timer;
  try {
    const remaining = deadline - performance.now(); if (remaining <= 0) throw new Error("Original resource probe deadline");
    const value = await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Resource probe observation deadline")), remaining);
    })]);
    if (performance.now() >= deadline) throw new Error("Resource probe late completion"); return value;
  } catch (error) { if (!diagnostic) fail(label + ":deadline-or-rejection"); throw error; }
  finally { clearTimeout(timer); }
}
async function work(label, operation, deadline) {
  alive(deadline); const value = await until(track(label, operation), deadline, label); alive(deadline); return value;
}
async function absent(path) {
  try { await lstat(path); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  throw new Error("Synthetic control file unexpectedly exists");
}
async function readBytes(path, maximum, oneLink = true) {
  const named = await lstat(path); assert(named.isFile() && !named.isSymbolicLink() && (!oneLink || named.nlink === 1));
  const file = await open(path, "r");
  try {
    const before = await file.stat(); assert(before.isFile() && (!oneLink || before.nlink === 1) && before.size > 0 && before.size <= maximum);
    const bytes = Buffer.alloc(before.size + 1); let used = 0;
    while (used < bytes.length) {
      const read = await file.read(bytes, used, bytes.length - used, used); if (!read.bytesRead) break; used += read.bytesRead;
    }
    const after = await file.stat();
    for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"]) { assert.equal(named[key], before[key]); assert.equal(before[key], after[key]); }
    assert.equal(used, before.size); return bytes.subarray(0, used);
  } finally { await file.close(); }
}
async function input() {
  const binding = JSON.parse((await readBytes(join(root, "resource-binding.json"), 16 * 1024)).toString("utf8"));
  assert.equal(binding.controlFile, join(control, "main-bootstrap.bin")); return binding;
}
async function verifySystemPowerShell() {
  const approval = JSON.parse((await readBytes(join(root, "os-binding.json"), 8192)).toString("utf8"));
  assert.deepEqual(Object.keys(approval).sort(), ["powerShell", "schema", "sha256", "systemRoot"]); assert.equal(approval.schema, 1);
  assert.equal(process.env.SystemRoot, approval.systemRoot); assert.match(approval.sha256, /^[a-f0-9]{64}$/);
  const actual = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  assert.equal(actual.toLowerCase(), approval.powerShell.toLowerCase());
  // Trusted Windows servicing may hard-link this separately approved OS image.
  // File identity/size/link-count and approved bytes still remain stable.
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update(await readBytes(actual, 4 * 1024 ** 2, false)).digest("hex"), approval.sha256);
  systemPowerShellVerified = true;
}
function sameParent(before, after) {
  assert(before.isDirectory() && after.isDirectory() && !before.isSymbolicLink() && !after.isSymbolicLink());
  for (const key of ["dev", "ino", "birthtimeNs"]) assert.equal(before[key], after[key]);
}

function outcome(promise, record, key) {
  const observed = promise.then(value => { record[key] = { status: "fulfilled" }; return value; }, error => {
    record[key] = { status: "rejected", reason: errorInfo(error) }; fail(record.label + ":" + key); throw error;
  });
  void observed.catch(() => {}); return observed;
}
function semantic(value) { return value.status === "fulfilled" ? { status: "fulfilled" }
  : { status: "rejected", reason: errorInfo(value.reason) }; }
function sealNative(record) {
  if (record.nativeWatcher && !record.nativeSealed) { record.nativeSealed = true; record.nativePrimary = record.nativeWatcher.sealPrimary(); }
}
function snapshot(record) {
  return { label: record.label, resultSettled: record.resultSettled, originalOutcome: record.originalOutcome, error: record.error,
    semanticOutcome: record.semanticOutcome, verification: record.verification, operation: record.operation,
    nativeSemanticOutcome: record.nativeSemanticOutcome, nativeBinding: record.nativeBinding,
    native: record.nativeWatcher?.snapshot() ?? null, observationFinished: record.observationFinished,
    observationError: record.observationError, observerStatuses: record.observerStatuses };
}
async function lateCall(record) {
  if (record.lateCallRequested) return; record.lateCallRequested = true;
  const deadline = performance.now() + 1000;
  try {
    await until(track("late-" + record.label + "-call", () => {
      if (performance.now() >= deadline) throw new Error("Late diagnostic expired before write");
      return writeFile(join(root, "late-" + record.label + "-call.json"), JSON.stringify({ schema: 1,
        kind: "late-bound-call-observation", upgradesOriginalResult: false, firstFailure, call: snapshot(record) }, null, 2) + "\n", { flag: "wx" });
    }), deadline, "late-call", true);
  } catch { fail("late-call-diagnostic-not-confirmed"); }
}
async function observe(record, observation) {
  const binding = await observation.binding; mark("call-binding", record.label);
  const observations = [];
  if (binding.verification) observations.push(outcome(binding.verification, record, "verification"));
  else record.verification = { status: "not-started" };
  if (binding.operation) observations.push(outcome(binding.operation, record, "operation"));
  else record.operation = { status: "not-started" };
  record.nativeBinding = binding.native.state;
  observations.push(observation.outcome.then(value => {
    record.semanticOutcome = semantic(value); if (value.status === "rejected") fail(record.label + ":semantic-outcome");
  }));
  if (binding.native.state === "bound") {
    observations.push(binding.native.observation.outcome.then(value => {
      record.nativeSemanticOutcome = semantic(value); if (value.status === "rejected") fail(record.label + ":native-semantic-outcome");
    }));
    const native = await binding.native.observation.binding; record.nativeBinding = native.kind;
    if (native.kind === "task") {
      record.nativeWatcher = new NativeLaunchObservation({ result: native.result, settled: native.settled }, {
        label: record.label, now: () => performance.now(), fail, firstFailure: () => structuredClone(firstFailure),
        event: stage => mark(stage, record.label),
        write: receipt => track("late-" + record.label + "-native", () => writeFile(join(root, "late-" + record.label + "-native.json"),
          JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" })),
      });
      if (primarySealed) sealNative(record);
      observations.push(record.nativeWatcher.result, record.nativeWatcher.settled);
    } else fail(record.label + ":missing-native-task");
  } else if (binding.native.state === "unavailable") fail(record.label + ":native-observer-unavailable");
  const statuses = await Promise.allSettled(observations);
  record.observerStatuses = statuses.map(value => value.status === "fulfilled" ? { status: "fulfilled" }
    : { status: "rejected", reason: errorInfo(value.reason) });
  if (statuses.some(value => value.status === "rejected")) fail(record.label + ":original-observation-rejected");
  record.observationFinished = true; mark("call-observed", record.label);
  if (primarySealed) await lateCall(record);
}
async function launch(label) {
  const deadline = phaseDeadline(20_000); alive(deadline);
  assert.equal(owner.status().pending, false); assert.equal(owner.status().failed, false);
  const controller = new AbortController(); controllers.push(controller);
  const record = { label, resultSettled: false, originalOutcome: null, error: null, lateCallRequested: false, semanticOutcome: null, verification: null,
    operation: null, nativeSemanticOutcome: null, nativeBinding: "pending", nativeWatcher: null,
    nativeSealed: false, nativePrimary: null, observationFinished: false, observationError: null, observerStatuses: [] };
  calls.push(record); mark("call-enter", label);
  const original = label === "directory" ? owner.prepareDirectory(deadline, controller.signal)
    : label === "identity" ? owner.identity(deadline, controller.signal)
    : owner.bootstrap("recover", undefined, deadline, controller.signal);
  record.original = original;
  // Own the semantic result BEFORE an observation lookup can synchronously fail.
  const result = original.then(value => {
    record.resultSettled = true; record.originalOutcome = { status: "fulfilled" };
    if (primarySealed && record.observationError) void lateCall(record); return value;
  }, error => {
    record.resultSettled = true; record.error = errorInfo(error);
    record.originalOutcome = { status: "rejected", reason: record.error }; fail(label + ":original-result");
    if (primarySealed && record.observationError) void lateCall(record); throw error;
  });
  record.resultObservation = result; void result.catch(() => {});
  try { record.observation = owner.observeCall(original); }
  catch (error) {
    record.nativeBinding = "unavailable"; record.observationError = errorInfo(error);
    record.observationFinished = true; fail(label + ":observation-lookup"); throw error;
  }
  record.observing = observe(record, record.observation).catch(error => {
    record.observationError = errorInfo(error); record.observationFinished = true; fail(label + ":observer-error");
    if (primarySealed) return lateCall(record);
  });
  const value = await until(result, deadline, label + ":result");
  await until(record.observing, deadline, label + ":bound-observation"); alive(deadline);
  const native = record.nativeWatcher?.snapshot();
  assert.equal(record.nativeBinding, "task"); assert.equal(record.observationError, null);
  assert.equal(record.semanticOutcome.status, "fulfilled"); assert.equal(record.nativeSemanticOutcome.status, "fulfilled");
  assert.equal(record.verification.status, "fulfilled"); assert.equal(record.operation.status, "fulfilled");
  assert(record.observerStatuses.every(item => item.status === "fulfilled"));
  assert.equal(native.resultSettled, true); assert.equal(native.settlementObserved, true); assert.equal(native.error, null);
  assert.deepEqual(native.settlement, { childCloseObserved: true, workerExited: true, workerExitCode: 0,
    authorityCommitted: label !== "identity", uncertain: false });
  assert.equal(native.authorityCommitted, label !== "identity");
  assert.equal(owner.status().pending, false); assert.equal(owner.status().failed, false); return value;
}
try {
  // NEW fixture budget75s, not production Main policy or old run evidence.
  const preparationDeadline = phaseDeadline(10_000);
  const parentBefore = await work("parent-before", () => lstat(root, { bigint: true }), preparationDeadline);
  await work("control-initial-absence", () => absent(control), preparationDeadline);
  await work("system-powershell-binding", verifySystemPowerShell, preparationDeadline);
  const binding = await work("read-binding", input, preparationDeadline);
  const controller = new AbortController(); controllers.push(controller);
  owner = await work("resource-factory", () => {
    preparationRequested = true; return loadNativeLaunchMcpResources(binding, preparationDeadline, controller.signal);
  }, preparationDeadline);
  preparationReturned = true;
  assert.equal(owner.status().directoryPrepared, false);
  assert.equal(await launch("directory"), undefined);
  assert.equal(owner.status().directoryPrepared, true);
  const directoryDeadline = phaseDeadline(2000);
  const directory = await work("physical-control", () => lstat(control), directoryDeadline);
  assert(directory.isDirectory() && !directory.isSymbolicLink());
  assert.equal(relative(control, await work("physical-control-path", () => realpath(control), directoryDeadline)), "");
  sameParent(parentBefore, await work("parent-after-directory", () => lstat(root, { bigint: true }), directoryDeadline)); ++completed;
  const identity = await launch("identity"); assert.equal(identity.pid, process.pid); assert(identity.creationTime > 0n); ++completed;
  const fixtureDeadline = phaseDeadline(2000);
  await work("pending-absence", () => absent(join(control, "main-bootstrap.pending")), fixtureDeadline);
  await work("final-absence", () => absent(join(control, "main-bootstrap.bin")), fixtureDeadline);
  await work("pending-create", () => writeFile(join(control, "main-bootstrap.pending"),
    Buffer.from([84, 77, 66, 79, 79, 84, 49, 0]), { flag: "wx" }), fixtureDeadline);
  assert.equal(await launch("recover"), undefined);
  const afterDeadline = phaseDeadline(2000);
  await work("native-pending-absent", () => absent(join(control, "main-bootstrap.pending")), afterDeadline);
  await work("native-final-absent", () => absent(join(control, "main-bootstrap.bin")), afterDeadline); ++completed;
  await assert.rejects(loadNativeLaunchMcpResources(binding, ownerDeadline, new AbortController().signal), /already claimed/);
} catch { fail("probe-operation-or-assertion"); }
finally {
  closing = true; mark("teardown-enter"); for (const controller of controllers) controller.abort();
  const original = [...pending.values()].map(entry => entry.observed);
  for (const record of calls) original.push(record.original, record.resultObservation, record.observing);
  try { await until(Promise.allSettled(original.filter(Boolean)), performance.now() + 1000, "diagnostic-drain", true); }
  catch { fail("teardown-unsettled"); }
  if (pending.size || calls.some(record => !record.resultSettled || !record.observationFinished)) fail("outstanding-original-work");
  const status = owner?.status() ?? null;
  if (!owner || status.pending || status.failed) fail("owner-not-clean");
  primarySealed = true; for (const record of calls) sealNative(record); mark("primary-sealed");
  const passed = !firstFailure && !overflow && completed === 3;
  const report = { schema: 1, passed, firstFailure, completed, ownerStatus: status, originalFixtureOwnerBudgetMs: 75000, systemPowerShellVerified,
    pending: [...pending.values()].map(entry => entry.label), preparationReturned,
    preparationBackgroundUnknown: preparationRequested && !preparationReturned, calls: calls.map(snapshot), eventsOverflow: overflow, events,
    automaticRetries: 0, forcedWorkerTermination: false, modelExecuted: false, brokerOperationExecuted: false, networkRequested: false };
  try { await until(track("primary-diagnostic", () => writeFile(join(root, "resource-result.json"),
    JSON.stringify(report, null, 2) + "\n", { flag: "wx" })), performance.now() + 1000, "primary-diagnostic", true); }
  catch { fail("primary-diagnostic-not-confirmed"); }
  if (!passed || firstFailure) process.exitCode = 1;
  // No process.exit/Worker.terminate/unref/retry. Native owners and original IO
  // remain observable; a late native close writes a separate bound receipt.
}
