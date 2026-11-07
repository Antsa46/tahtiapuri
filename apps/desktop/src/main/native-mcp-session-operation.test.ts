import { afterEach, expect, it, vi } from "vitest";
import type { EventEmitter } from "node:events";
import type { PassThrough, Writable } from "node:stream";
const state = vi.hoisted(() => ({ current: undefined as undefined | {
  child: EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
  file: string; args: string[]; options: { env: NodeJS.ProcessEnv; stdio: string[]; windowsHide: boolean }; input: Buffer[];
}, onSpawn: undefined as (() => void) | undefined }));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events"), { PassThrough, Writable } = await import("node:stream");
  return { spawn: (file: string, args: string[], options: NonNullable<typeof state.current>["options"]) => {
    const input: Buffer[] = [];
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true), stdout: new PassThrough(), stderr: new PassThrough(),
      stdin: new Writable({ write(chunk, _encoding, callback) { input.push(Buffer.from(chunk)); callback(); } }) });
    state.current = { child, file, args, options, input }; state.onSpawn?.(); return child;
  } };
});
import { runNativeMcpSessionOperation } from "./native-mcp-session-operation.js";
import { encodeNativeBootstrap } from "./native-development-bootstrap.js";
const test = process.platform === "win32" ? it : it.skip;
const helper = "C:\\synthetic\\mcp-broker.exe", file = "C:\\synthetic\\control\\main-bootstrap.bin";
const bytes = () => encodeNativeBootstrap({ main: { pid: process.pid, creationTime: 1n }, pipeNonce: "11".repeat(16),
  ticket: { generation: "22".repeat(16), token: "33".repeat(32) } });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
afterEach(() => { state.current?.child.stdin.destroy(); state.current?.child.stdout.destroy(); state.current?.child.stderr.destroy(); state.current = undefined; state.onSpawn = undefined; vi.useRealTimers(); });
test("sends copied bytes only through stdin with fixed arguments and a stripped environment", async () => {
  const input = bytes(), original = Buffer.from(input), done = runNativeMcpSessionOperation(helper, "publish", file, input);
  input.fill(0); const c = state.current!;
  expect(c.file).toBe(helper); expect(c.args).toEqual(["--publish", file]); expect(Buffer.concat(c.input)).toEqual(original);
  expect(c.options).toMatchObject({ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  expect(Object.keys(c.options.env).every(key => ["SystemRoot", "WINDIR", "TEMP", "TMP"].includes(key))).toBe(true);
  c.child.stdout.write("published\n"); c.child.emit("close", 0); await done;
});
test("output and stdin callbacks do not substitute for actual helper close", async () => {
  let settled = false; const done = runNativeMcpSessionOperation(helper, "seal", file, bytes()).then(() => { settled = true; });
  const c = state.current!.child; c.stdout.write("session-sealed\n"); await tick(); expect(settled).toBe(false);
  c.emit("close", 0); await done; expect(settled).toBe(true);
});
test("abort before launch does not start the helper", async () => {
  const abort = new AbortController(); abort.abort();
  await expect(runNativeMcpSessionOperation(helper, "prepare", file, bytes(), abort.signal)).rejects.toMatchObject({ exitVerified: true });
  expect(state.current).toBeUndefined();
});
test("abort during operation waits for close and rejects even a success message", async () => {
  const abort = new AbortController();
  const done = runNativeMcpSessionOperation(helper, "publish", file, bytes(), abort.signal).catch(error => error);
  const c = state.current!.child; abort.abort(); expect(c.kill).toHaveBeenCalledTimes(1);
  let settled = false; void done.then(() => { settled = true; }); c.stdout.write("published\n"); await tick(); expect(settled).toBe(false);
  c.emit("close", 0); expect(await done).toMatchObject({ exitVerified: true });
});
test("unobserved exit remains uncertain after the parent deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const done = runNativeMcpSessionOperation(helper, "prepare", file, bytes()).catch(error => error);
  state.current!.child.stdout.write("session-prepared\n");
  await vi.advanceTimersByTimeAsync(6000);
  expect(await done).toMatchObject({ exitVerified: false }); expect(state.current!.child.kill).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0); state.current!.child.emit("close", 0);
});
for (const failure of ["stdout-limit", "stderr", "wrong-output", "exit-code", "spawn-error", "stdin-error"] as const)
  test("rejects helper failure: " + failure, async () => {
    const done = runNativeMcpSessionOperation(helper, "prepare", file, bytes()).catch(error => error), child = state.current!.child;
    if (failure === "stdout-limit") child.stdout.write("x".repeat(65));
    else if (failure === "wrong-output") child.stdout.write("published\n");
    else child.stdout.write("session-prepared\n");
    if (failure === "stderr") child.stderr.write("unexpected");
    if (failure === "spawn-error") child.emit("error", new Error("Synthetic spawn error"));
    if (failure === "stdin-error") child.stdin.emit("error", new Error("Synthetic input error"));
    child.emit("close", failure === "exit-code" ? 1 : 0);
    expect(await done).toMatchObject({ exitVerified: true });
  });
test("validates mode, fixed leaf, exact bytes and Main PID before spawning", async () => {
  const foreign = bytes(); foreign.writeUInt32LE(process.pid + 1, 16);
  for (const call of [
    () => runNativeMcpSessionOperation("other.exe", "publish", file, bytes()),
    () => runNativeMcpSessionOperation(helper, "publish", "C:\\synthetic\\other.bin", bytes()),
    () => runNativeMcpSessionOperation(helper, "publish", file, bytes().subarray(0, 95)),
    () => runNativeMcpSessionOperation(helper, "seal", file, foreign),
    () => runNativeMcpSessionOperation(helper, "recover" as never, file, bytes()),
  ]) await expect(call()).rejects.toThrow();
  expect(state.current).toBeUndefined();
});

test("a publish receipt does not acknowledge release-pristine", async () => {
  const done = runNativeMcpSessionOperation(helper, "release-pristine", file, bytes()).catch(error => error);
  state.current!.child.stdout.write("published\n"); state.current!.child.emit("close", 0);
  expect(await done).toMatchObject({ exitVerified: true });
});

test("an expired owner deadline never starts a child", async () => {
  await expect(runNativeMcpSessionOperation(helper, "release-pristine", file, bytes(), undefined, performance.now() - 1)).rejects.toMatchObject({ exitVerified: true });
  expect(state.current).toBeUndefined();
});
test("a verified child close after its owner deadline still rejects", async () => {
  const deadline = performance.now() + 1000;
  const result = runNativeMcpSessionOperation(helper, "release-pristine", file, bytes(), undefined, deadline).catch(error => error);
  const clock = vi.spyOn(performance, "now").mockReturnValue(deadline + 1);
  try {
    state.current!.child.stdout.write("session-released\n"); state.current!.child.emit("close", 0);
    expect(await result).toMatchObject({ exitVerified: true });
  } finally { clock.mockRestore(); }
});

test("a synchronous late spawn receives no authority bytes and still needs actual close", async () => {
  let now = performance.now(); const deadline = now + 1000;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  state.onSpawn = () => { now = deadline + 1; };
  const result = runNativeMcpSessionOperation(helper, "release-pristine", file, bytes(), undefined, deadline).catch(error => error);
  try {
    const current = state.current!; expect(current.input).toEqual([]);
    expect(current.child.kill).toHaveBeenCalledTimes(1); expect(current.child.stdin.destroyed).toBe(true);
    let settled = false; void result.then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
    current.child.emit("close", 1); expect(await result).toMatchObject({ exitVerified: true });
  } finally { clock.mockRestore(); }
});

for (const operation of ["release-pristine", "release-clean"] as const) {
  test(operation + " requires its distinct receipt and actual close", async () => {
    const input = bytes(), expected = Buffer.from(input);
    const done = runNativeMcpSessionOperation(helper, operation, file, input);
    input.fill(0); const current = state.current!;
    expect(current.args).toEqual(["--" + operation, file]); expect(Buffer.concat(current.input)).toEqual(expected);
    let settled = false; void done.then(() => { settled = true; });
    current.child.stdout.write(operation === "release-clean" ? "session-clean-released\n" : "session-released\n");
    await tick(); expect(settled).toBe(false); current.child.emit("close", 0); await done;
  });
  test(operation + " rejects the other release kind receipt", async () => {
    const done = runNativeMcpSessionOperation(helper, operation, file, bytes()).catch(error => error);
    state.current!.child.stdout.write(operation === "release-clean" ? "session-released\n" : "session-clean-released\n");
    state.current!.child.emit("close", 0); expect(await done).toMatchObject({ exitVerified: true });
  });
}
