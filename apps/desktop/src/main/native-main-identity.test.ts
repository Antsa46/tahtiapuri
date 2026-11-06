import { afterEach, expect, it, vi } from "vitest";
import type { EventEmitter } from "node:events";
const state = vi.hoisted(() => ({ active: undefined as undefined | {
  child: EventEmitter & { kill: ReturnType<typeof vi.fn> }; resolve(value: { stdout: string; stderr: string }): void; reject(error: Error): void;
  file: string; args: string[]; options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; windowsHide: boolean };
} }));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const custom = (file: string, args: string[], options: NonNullable<typeof state.active>["options"]) => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
    let resolve!: NonNullable<typeof state.active>["resolve"], reject!: (error: Error) => void;
    const promise = new Promise<{ stdout: string; stderr: string }>((ok, fail) => { resolve = ok; reject = fail; });
    state.active = { child, resolve, reject, file, args, options }; return Object.assign(promise, { child });
  };
  return { execFile: Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: custom }) };
});
import { queryNativeMainIdentity, NativeIdentityProcessError } from "./native-main-identity.js";
const test = process.platform === "win32" ? it : it.skip;
const helper = "C:\\synthetic\\main-identity.exe";
const correct = () => ({ stdout: '{"pid":' + process.pid + ',"creationTime":"0807060504030201"}\n', stderr: "" });
const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); state.active = undefined; });
test("queries only this process with fixed arguments and a stripped child environment", async () => {
  const promise = queryNativeMainIdentity(helper); const active = state.active!;
  expect(active.file).toBe(helper); expect(active.args).toEqual(["--identity", String(process.pid)]);
  expect(active.options).toMatchObject({ timeout: 3000, maxBuffer: 128, windowsHide: true });
  expect(Object.keys(active.options.env).every(key => ["SystemRoot", "WINDIR", "TEMP", "TMP"].includes(key))).toBe(true);
  active.resolve(correct()); active.child.emit("close", 0);
  expect(await promise).toEqual({ pid: process.pid, creationTime: 0x0807060504030201n });
});
test("does not treat callback completion as confirmed process exit", async () => {
  const promise = queryNativeMainIdentity(helper); let settled = false; void promise.then(() => { settled = true; });
  state.active!.resolve(correct()); await tick(); expect(settled).toBe(false);
  state.active!.child.emit("close", 0); await promise; expect(settled).toBe(true);
});
test("waits for close after an early helper error", async () => {
  const promise = queryNativeMainIdentity(helper); let settled = false;
  const outcome = promise.catch(error => { settled = true; return error; });
  state.active!.reject(new Error("Synthetic helper failure")); await tick(); expect(settled).toBe(false);
  state.active!.child.emit("close", 1); expect(await outcome).toMatchObject({ exitVerified: true });
});
test("reports unresolved exit and never publishes an identity without close", async () => {
  vi.useFakeTimers(); const outcome = queryNativeMainIdentity(helper).catch(error => error);
  state.active!.resolve(correct()); await vi.advanceTimersByTimeAsync(4000);
  const failure = await outcome; expect(failure).toBeInstanceOf(NativeIdentityProcessError); expect(failure.exitVerified).toBe(false);
  expect(state.active!.child.kill).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
for (const variant of ["other-pid", "zero-time", "numeric-time", "extra-output", "stderr"] as const)
  test("rejects helper result " + variant, async () => {
    const outcome = queryNativeMainIdentity(helper).catch(error => error), result = correct();
    if (variant === "other-pid") result.stdout = result.stdout.replace(String(process.pid), String(process.pid + 1));
    if (variant === "zero-time") result.stdout = result.stdout.replace("0807060504030201", "0000000000000000");
    if (variant === "numeric-time") result.stdout = result.stdout.replace('"0807060504030201"', "578437695752307201");
    if (variant === "extra-output") result.stdout += "extra";
    if (variant === "stderr") result.stderr = "unexpected diagnostic";
    state.active!.resolve(result); state.active!.child.emit("close", 0);
    expect(await outcome).toMatchObject({ exitVerified: true });
  });
test("rejects nonlocal, noncanonical and wrong helper paths before launch", async () => {
  for (const path of ["main-identity.exe", "\\\\server\\share\\main-identity.exe", "C:\\synthetic\\..\\main-identity.exe", "C:\\synthetic\\other.exe"])
    await expect(queryNativeMainIdentity(path)).rejects.toThrow("Invalid native identity helper");
  expect(state.active).toBeUndefined();
});
