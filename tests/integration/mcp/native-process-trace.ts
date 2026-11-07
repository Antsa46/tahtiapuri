import type * as ChildProcess from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { win32 } from "node:path";
import { promisify } from "node:util";

type Detail = { pid?: number; code?: number | null; signal?: string | null; failureClass?: string; exitVerified?: boolean; delivered?: boolean };
type Event = Detail & { atMs: number; event: string; operation: string; call?: number };
export type ProcessTraceScope = { id: number; events: Event[]; overflow: boolean; uncertain: boolean };
type Owned = {
  child: ChildProcess.ChildProcess; closed: Promise<void>;
  record: { call: number; operation: string; pid: number | null; observedClose: boolean; exit: { code: number | null; signal: string | null } | null };
};
const operations = new Set(["--identity", "--publish", "--consume", "--recover", "--prepare", "--seal", "--publish-hold", "--admit-hold", "--protect-session"]);
const helperNames = new Set(["powershell.exe", "main-identity.exe", "main-bootstrap.exe", "session-gate.exe"]);

/** Test-only observation of owned children. No arguments, environment, streams,
 * descriptor bytes, or full paths are retained. Every wrapper returns the
 * original result, including execFile's custom promise and its .child handle. */
export function createNativeProcessTrace() {
  const started = performance.now(), owned = new Map<ProcessTraceScope, Owned[]>(), context = new AsyncLocalStorage<ProcessTraceScope>();
  let active: ProcessTraceScope, nextScope = 0, nextCall = 0;
  function begin(): ProcessTraceScope {
    active = { id: ++nextScope, events: [], overflow: false, uncertain: false };
    owned.set(active, []); return active;
  }
  begin();
  function note(scope: ProcessTraceScope, event: string, operation: string, detail: Detail = {}, call?: number) {
    try {
      if (scope.events.length >= 512) { scope.overflow = true; scope.uncertain = true; return; }
      scope.events.push({ atMs: performance.now() - started, event, operation, ...detail, ...(call === undefined ? {} : { call }) });
    } catch { scope.uncertain = true; }
  }
  function failure(error: unknown): Detail {
    try {
      const value = error as { constructor?: { name?: unknown }; exitVerified?: unknown } | null;
      const name = value?.constructor?.name;
      return { failureClass: typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : "Unknown",
        ...(typeof value?.exitVerified === "boolean" ? { exitVerified: value.exitVerified } : {}) };
    } catch { return { failureClass: "Unobservable" }; }
  }
  function rejected(scope: ProcessTraceScope, operation: string, error: unknown) {
    const detail = failure(error); note(scope, "operation-rejected", operation, detail);
    if (detail.exitVerified === false || detail.failureClass === "Unobservable") scope.uncertain = true;
    return scope.uncertain;
  }
  function observe(scope: ProcessTraceScope, child: ChildProcess.ChildProcess, operation: string, call: number) {
    try {
      const record: Owned["record"] = { call, operation, pid: child.pid ?? null, observedClose: false, exit: null };
      let done!: () => void;
      const closed = new Promise<void>(resolve => { done = resolve; });
      owned.get(scope)!.push({ child, closed, record });
      child.once("spawn", () => note(scope, "child-spawn", operation, { pid: child.pid! }, call));
      child.once("error", error => note(scope, "child-error", operation, failure(error), call));
      child.once("exit", (code, signal) => note(scope, "child-exit", operation, { code, signal }, call));
      child.once("close", (code, signal) => {
        record.observedClose = true; record.exit = { code, signal };
        note(scope, "child-close", operation, { code, signal }, call); done();
      });
      const kill = child.kill;
      child.kill = function (...args: Parameters<typeof kill>) {
        note(scope, "kill-request", operation, {}, call);
        try {
          const result = Reflect.apply(kill, this, args) as boolean;
          note(scope, "kill-return", operation, { delivered: result }, call); return result;
        } catch (error) {
          note(scope, "kill-throw", operation, failure(error), call); throw error;
        }
      };
    } catch { scope.uncertain = true; }
  }
  function label(args: unknown[]): string {
    try {
      const name = typeof args[0] === "string" ? win32.basename(args[0]).toLowerCase() : "";
      const mode = Array.isArray(args[1]) && operations.has(args[1][0]) ? String(args[1][0]) : "";
      return (helperNames.has(name) ? name : "other-child") + mode;
    } catch { return "other-child"; }
  }
  function wrap(actual: typeof ChildProcess): typeof ChildProcess {
    function traced<T extends (...args: never[]) => unknown>(fn: T, api: string, custom = false): T {
      const wrapped = function (this: unknown, ...args: unknown[]) {
        const scope = context.getStore() ?? active, operation = label(args), call = ++nextCall;
        note(scope, api + "-enter", operation, {}, call);
        let result: unknown;
        try { result = Reflect.apply(fn, this, args); }
        catch (error) { note(scope, api + "-throw", operation, failure(error), call); throw error; }
        note(scope, api + "-return", operation, {}, call);
        if (custom) {
          const promise = result as Promise<unknown> & { child: ChildProcess.ChildProcess };
          observe(scope, promise.child, operation, call);
          void promise.then(() => note(scope, "exec-promise-resolved", operation, {}, call),
            error => note(scope, "exec-promise-rejected", operation, failure(error), call));
        } else observe(scope, result as ChildProcess.ChildProcess, operation, call);
        return result;
      };
      const originalCustom = Reflect.get(fn, promisify.custom) as T | undefined;
      if (!custom && typeof originalCustom === "function") {
        Object.defineProperty(wrapped, promisify.custom, { value: traced(originalCustom, "execFile-custom", true) });
      }
      return wrapped as unknown as T;
    }
    return { ...actual, spawn: traced(actual.spawn, "spawn"), execFile: traced(actual.execFile, "execFile") };
  }
  async function within<T>(scope: ProcessTraceScope, work: () => Promise<T>, cap: number, operation: string,
    state: { end: number; controller: AbortController; pending: Set<Promise<unknown>>; taint: () => void }): Promise<T> {
    note(scope, "operation-requested", operation);
    const remaining = state.end - performance.now();
    if (remaining <= 0) throw new Error(operation + " before-start deadline");
    const limit = performance.now() + Math.min(cap, remaining);
    const actual = Promise.resolve().then(() => {
      if (performance.now() >= limit) throw new Error(operation + " dispatch deadline");
      return context.run(scope, work);
    });
    state.pending.add(actual);
    void actual.then(() => { state.pending.delete(actual); note(scope, "operation-resolved", operation); }, error => {
      state.pending.delete(actual);
      // Observe the original rejection even if an outer timer already won.
      if (rejected(scope, operation, error)) {
        state.taint(); note(scope, "abort-request", operation); state.controller.abort();
      }
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const value = await Promise.race([actual, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(operation + " deadline")), Math.max(0, limit - performance.now()));
      })]);
      if (performance.now() >= limit) throw new Error(operation + " late completion");
      return value;
    } catch (error) {
      if (performance.now() >= limit) {
        note(scope, "outer-deadline", operation); throw new Error(operation + " late completion", { cause: error });
      }
      throw error;
    } finally { clearTimeout(timer); }
  }
  return { begin, current: () => active, note, rejected, wrap, within,
    run: <T>(scope: ProcessTraceScope, work: () => T): T => context.run(scope, work),
    children: (scope: ProcessTraceScope) => owned.get(scope) ?? [],
    records: (scope: ProcessTraceScope) => (owned.get(scope) ?? []).map(child => child.record) };
}
