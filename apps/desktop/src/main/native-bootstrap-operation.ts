import { spawn } from "node:child_process";
import { createNativeRecoveryGrant } from "./native-recovery-grant.js";
import { requireNativeOperationDeadline } from "./native-operation-deadline.js";
import { win32 } from "node:path";
import { childEnvironment } from "./child-environment.js";
import { decodeNativeBootstrap, NATIVE_BOOTSTRAP_BYTES } from "./native-development-bootstrap.js";

export type NativeBootstrapOperation = "publish" | "consume" | "recover";
export class NativeBootstrapProcessError extends Error {
  constructor(readonly exitVerified: boolean) { super("Native bootstrap operation failed."); }
}
/** Trusted owner supplies an already verified helper package and serialized
 * calls under the app's single-instance lock. Recovery concerns descriptors
 * only; it never proves surviving broker/worker cleanup or authorizes rearm. */
export function runNativeBootstrapOperation(helper: string, operation: NativeBootstrapOperation, file: string,
  bytes?: Buffer, signal?: AbortSignal, deadline?: number): Promise<void> {
  const canonical = (path: string, leaf: string) => /^[A-Z]:\\/.test(path) && win32.normalize(path) === path && win32.basename(path) === leaf;
  if (process.platform !== "win32" || !canonical(helper, "main-bootstrap.exe") || !canonical(file, "main-bootstrap.bin")
    || !["publish", "consume", "recover"].includes(operation)) return Promise.reject(new Error("Invalid native bootstrap configuration."));
  if (operation === "recover" ? bytes !== undefined : !Buffer.isBuffer(bytes) || bytes.length !== NATIVE_BOOTSTRAP_BYTES)
    return Promise.reject(new Error("Invalid native bootstrap input."));
  try {
    if (bytes && decodeNativeBootstrap(bytes).main.pid !== process.pid) throw new Error("Invalid bootstrap owner.");
  } catch { return Promise.reject(new Error("Invalid native bootstrap input.")); }
  try { requireNativeOperationDeadline(deadline); } catch (error) { return Promise.reject(error); }
  if (signal?.aborted) return Promise.reject(new NativeBootstrapProcessError(true));
  // Copy before asynchronous work; later caller mutation cannot change the descriptor.
  const input = bytes ? Buffer.from(bytes) : createNativeRecoveryGrant();
  return new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      requireNativeOperationDeadline(deadline);
      child = spawn(helper, ["--" + operation, file], { windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"], env: childEnvironment(process.env) });
    } catch { input.fill(0); reject(new NativeBootstrapProcessError(true)); return; }
    let failed = false, finished = false, stdout = Buffer.alloc(0), stderrBytes = 0;
    const stop = () => { if (finished) return; failed = true; try { child.kill(); } catch { /* Close/deadline decides. */ } };
    const onAbort = () => stop();
    const exitDeadline = Math.min(performance.now() + 6000, deadline ?? Infinity);
    const timer = setTimeout(() => { stop(); finish(false); }, Math.max(0, exitDeadline - performance.now()));
    const finish = (exitVerified: boolean, code?: number | null) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); input.fill(0);
      const expected = operation === "publish" ? "published\n" : operation === "consume" ? "consumed\n" : "descriptor-absent\n";
      if (!exitVerified || failed || signal?.aborted || performance.now() >= exitDeadline
        || code !== 0 || stderrBytes || !stdout.equals(Buffer.from(expected)))
        reject(new NativeBootstrapProcessError(exitVerified));
      else resolve();
      stdout.fill(0);
    };
    child.on("error", stop);
    child.once("close", code => finish(true, code));
    child.stdout!.on("error", stop);
    child.stderr!.on("error", stop);
    child.stdin!.on("error", stop);
    child.stdout!.on("data", (chunk: Buffer) => {
      if (finished) return;
      if (!Buffer.isBuffer(chunk) || stdout.length + chunk.length > 64) { stop(); return; }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (finished) return;
      stderrBytes += chunk.length; failed = true;
      if (stderrBytes > 128) stop();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted || performance.now() >= exitDeadline) {
      // Synchronous CreateProcess can return after the owner deadline. Do not
      // deliver authority bytes to that already owned child. Close is still
      // required; withholding input does not prove process exit.
      stop(); child.stdin!.destroy(); return;
    }
    try { child.stdin!.end(input, () => { input.fill(0); }); } catch { stop(); }
  });
}
