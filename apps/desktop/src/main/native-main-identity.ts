import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { win32 } from "node:path";
import { childEnvironment } from "./child-environment.js";
import type { NativeMainIdentity } from "./native-development-bootstrap.js";

const execute = promisify(execFile);
export class NativeIdentityProcessError extends Error {
  constructor(readonly exitVerified: boolean) { super("Native Main identity query failed."); }
}
/** The owner supplies the fixed helper from its separately verified runtime
 * package. This query is not package verification or the broker's peer check. */
export async function queryNativeMainIdentity(helper: string): Promise<NativeMainIdentity> {
  if (process.platform !== "win32" || !/^[A-Z]:\\/.test(helper) || win32.normalize(helper) !== helper
    || win32.basename(helper) !== "main-identity.exe") throw new Error("Invalid native identity helper.");
  const operation = execute(helper, ["--identity", String(process.pid)], {
    windowsHide: true, timeout: 3000, maxBuffer: 128, encoding: "utf8", env: childEnvironment(process.env),
  });
  const outcome = operation.then(result => result, () => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      new Promise<void>(resolve => operation.child.once("close", () => resolve())),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
        operation.child.kill(); reject(new NativeIdentityProcessError(false));
      }, 4000); }),
    ]);
    const result = await outcome;
    if (!result || result.stderr !== "") throw new NativeIdentityProcessError(true);
    // Strict fixed output; bigint preserves all FILETIME bits above JS's safe integer range.
    const match = /^\{"pid":([1-9][0-9]{0,9}),"creationTime":"([a-f0-9]{16})"\}\r?\n$/.exec(result.stdout);
    if (!match || Number(match[1]) !== process.pid) throw new NativeIdentityProcessError(true);
    const creationTime = BigInt("0x" + match[2]);
    if (creationTime === 0n) throw new NativeIdentityProcessError(true);
    return Object.freeze({ pid: process.pid, creationTime });
  } finally { clearTimeout(timer); }
}
