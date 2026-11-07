import { createNativeCallRecord } from "../../../apps/desktop/src/main/native-launch-call-record.js";
import type { NativeLaunchResourceBinding, NativeLaunchResourceObservation } from "../../../apps/desktop/src/main/native-launch-resource-owner.js";
import type { NativeLaunchTaskBinding } from "../../../apps/desktop/src/main/native-launch-operations.js";
import type { NativeLaunchSettlement } from "../../../apps/desktop/src/main/native-launch-supervisor.js";
import type { NativeDevelopmentResources } from "../../../apps/desktop/src/main/native-development-host.js";
import type { NativeMcpHelpers } from "../../../apps/desktop/src/main/native-mcp-helpers.js";
import type { NativeMcpHostResources } from "../../../apps/desktop/src/main/native-mcp-resources.js";
import { win32 } from "node:path";
import { mkdir } from "node:fs/promises";

/** CONTROLLER FIXTURE ONLY. Promise/close records below are synthetic,
 * test-controlled observations, NEVER actual Worker/native/Windows evidence.
 * No native algorithm, process, ACL policy, journal or release oracle lives here. */
const originalWork = new WeakMap<object, Promise<unknown>[]>();
export async function observeSyntheticHostWork(resources: NativeDevelopmentResources): Promise<void> {
  const work = originalWork.get(resources);
  if (!work) throw new Error("Unknown synthetic Host owner");
  await Promise.allSettled(work); // Test teardown only; no runtime close claim.
}
export function syntheticHostResources(controlFile: string, helpers: NativeMcpHelpers,
  stage: NativeMcpHostResources["prepareWorker"], session: NativeMcpHostResources["session"]): NativeDevelopmentResources {
  let active: { kind: "native" | "stage" } | undefined, failed = false, directoryPrepared = false, lastSettlement: NativeLaunchSettlement | null = null;
  const observations = new WeakMap<Promise<unknown>, NativeLaunchResourceObservation>();
  const originals: Promise<unknown>[] = [];
  const failure = (exitVerified = true) => Object.assign(new Error("Synthetic controller resource failure"), { exitVerified, authorityCommitted: false });
  function invoke<T>(kind: "native" | "stage", execute: (signal: AbortSignal) => Promise<T>, ownerDeadline: number,
    caller: AbortSignal, authority: boolean, directory = false): Promise<T> {
    const empty: NativeLaunchResourceBinding = kind === "stage"
      ? { kind: "stage", staging: null, verification: null, operation: null, native: { state: "none" } }
      : { kind: "native", staging: null, verification: null, operation: null, native: { state: "none" } };
    const record = createNativeCallRecord(empty);
    let raw: Promise<T> | undefined, token: { kind: "native" | "stage" } | undefined;
    const original = (async () => {
      if (active || failed) throw failure(false);
      if (directory ? directoryPrepared : !directoryPrepared) { failed = true; throw failure(); }
      token = { kind }; active = token;
      const deadline = Math.min(ownerDeadline, performance.now() + (kind === "stage" ? 30_000 : 20_000));
      const abort = new AbortController(), cancelTimer = clearTimeout; let rejectBoundary!: (error: Error) => void, timer: NodeJS.Timeout | undefined;
      const stop = () => { failed = true; abort.abort(); rejectBoundary(failure()); };
      const check = () => {
        if (!Number.isFinite(deadline) || performance.now() >= deadline || caller.aborted || abort.signal.aborted || failed) throw failure();
      };
      try {
        check();
        const boundary = new Promise<never>((_resolve, reject) => { rejectBoundary = reject; }); void boundary.catch(() => {});
        caller.addEventListener("abort", stop, { once: true }); check();
        timer = setTimeout(stop, Math.max(0, deadline - performance.now()));
        check(); raw = execute(abort.signal); originals.push(raw);
        void raw.then(() => { if (active === token) active = undefined; }, () => { failed = true; if (active === token) active = undefined; });
        const value = await Promise.race([raw, boundary]); check(); return value;
      } catch (error) { failed = true; abort.abort(); throw error; }
      finally {
        cancelTimer(timer); caller.removeEventListener("abort", stop);
        if (!raw && active === token) active = undefined;
      }
    })();
    record.attach(original); observations.set(original, record.observation);
    if (raw) {
      if (kind === "stage") record.bind({ kind, staging: raw as Promise<void>, verification: null, operation: null, native: { state: "none" } });
      else {
        const settled: Promise<NativeLaunchSettlement> = raw.then(() => ({ childCloseObserved: true, workerExited: true,
          workerExitCode: 0, authorityCommitted: authority, uncertain: false }), error => {
          const known = !!error && typeof error === "object" && "exitVerified" in error && error.exitVerified === true;
          return { childCloseObserved: known, workerExited: known, workerExitCode: known ? 0 : null, authorityCommitted: authority, uncertain: !known };
        });
        void settled.then(value => { lastSettlement = value; });
        const result = original.then(() => ({ stdout: Buffer.from("synthetic controller receipt"), authorityCommitted: authority }));
        void result.catch(() => {});
        const native = createNativeCallRecord<NativeLaunchTaskBinding>({ kind: "no-task" });
        native.attach(original); native.bind({ kind: "task", result, settled });
        record.bind({ kind, staging: null, verification: Promise.resolve(), operation: original,
          native: { state: "bound", observation: native.observation } });
      }
    }
    return original;
  }
  const resources: NativeDevelopmentResources = {
    controlFile,
    prepareDirectory: (deadline, signal) => invoke("native", async activeSignal => {
      activeSignal.throwIfAborted(); await mkdir(win32.dirname(controlFile), { recursive: true }); directoryPrepared = true;
    }, deadline, signal, true, true),
    identity: (deadline, signal) => invoke("native", activeSignal => helpers.identity(activeSignal), deadline, signal, false),
    bootstrap: (operation, bytes, deadline, signal) => invoke("native", async activeSignal => {
      const input = bytes ? Buffer.from(bytes) : undefined;
      try { await helpers.operate(operation, controlFile, input, activeSignal, deadline); } finally { input?.fill(0); }
    }, deadline, signal, true),
    session: (operation, bytes, deadline, signal) => invoke("native", async activeSignal => {
      const input = Buffer.from(bytes);
      try { await session(operation, controlFile, input, activeSignal, deadline); } finally { input.fill(0); }
    }, deadline, signal, true),
    prepareWorker: (deadline, signal) => invoke("stage", activeSignal => stage(win32.join(win32.dirname(controlFile), "native-session-reserved"), activeSignal), deadline, signal, false),
    observeCall: original => { const observation = observations.get(original); if (!observation) throw new Error("Unknown synthetic original call"); return observation; },
    status: () => Object.freeze({ pending: !!active, failed, verificationPending: false, stagingPending: active?.kind === "stage", directoryPrepared, lastSettlement }),
  };
  originalWork.set(resources, originals);
  return Object.freeze(resources);
}

/** Fault injection for a selected SYNTHETIC task only. Original public Promise
 * identity and every other original handle remain unchanged. */
export function withSyntheticTaskSettlement(resources: NativeDevelopmentResources, select: "identity" | "publish",
  settled: Promise<NativeLaunchSettlement>): NativeDevelopmentResources {
  let target: Promise<unknown> | undefined;
  return Object.freeze({ ...resources,
    identity: (deadline: number, signal: AbortSignal) => {
      const original = resources.identity(deadline, signal); if (select === "identity") target = original; return original;
    },
    session: (operation: Parameters<NativeDevelopmentResources["session"]>[0], bytes: Uint8Array, deadline: number, signal: AbortSignal) => {
      const original = resources.session(operation, bytes, deadline, signal);
      if (select === "publish" && operation === "publish") target = original; return original;
    },
    observeCall(original: Promise<unknown>): NativeLaunchResourceObservation {
      const observation = resources.observeCall(original); if (original !== target) return observation;
      return Object.freeze({ outcome: observation.outcome, binding: observation.binding.then(binding => {
        if (binding.kind !== "native" || binding.native.state !== "bound") return binding;
        const native = binding.native.observation;
        return Object.freeze({ ...binding, native: Object.freeze({ state: "bound" as const,
          observation: Object.freeze({ outcome: native.outcome, binding: native.binding.then(task =>
            task.kind === "task" ? Object.freeze({ ...task, settled }) : task) }) }) });
      }) });
    },
  });
}
