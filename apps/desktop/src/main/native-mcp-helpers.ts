import { requireNativeOperationDeadline } from "./native-operation-deadline.js";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, win32 } from "node:path";
import { createHash } from "node:crypto";
import { queryNativeMainIdentity } from "./native-main-identity.js";
import { runNativeBootstrapOperation, type NativeBootstrapOperation } from "./native-bootstrap-operation.js";

export type HelperPin = Readonly<{ bytes: number; sha256: string }>;
export type NativeMcpHelperPins = Readonly<{ "main-identity.exe": HelperPin; "main-bootstrap.exe": HelperPin }>;
const names = ["main-identity.exe", "main-bootstrap.exe"] as const;
const denied = (): never => { throw new Error("Native MCP helper package rejected."); };
async function directory(path: string): Promise<void> {
  for (;;) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || relative(path, await realpath(path)) !== "") denied();
    const parent = dirname(path); if (parent === path) return; path = parent;
  }
}
async function verify(root: string, pins: NativeMcpHelperPins): Promise<void> {
  await directory(root);
  const expected = new Set<string>(names);
  for await (const entry of await opendir(root, { bufferSize: 1 })) {
    if (!expected.delete(entry.name)) denied();
  }
  if (expected.size) denied();
  for (const name of names) {
    const path = join(root, name), pin = pins[name], named = await lstat(path);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size !== pin.bytes
      || relative(path, await realpath(path)) !== "") denied();
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat(), bytes = await handle.readFile(), after = await handle.stat(), current = await lstat(path);
      for (const key of ["dev", "ino", "size", "nlink", "mtimeMs", "ctimeMs"] as const)
        if (named[key] !== before[key] || before[key] !== after[key] || after[key] !== current[key]) denied();
      if (bytes.length !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256) denied();
    } finally { await handle.close(); }
  }
  await directory(root);
}
/** Pins come from trusted composition/build evidence, never from a manifest in
 * the same untrusted directory. Same-user/admin mutation is outside this boundary;
 * these checks are not Windows write/delete-excluding executable handle pins. */
export async function loadNativeMcpHelpers(root: string, supplied: NativeMcpHelperPins) {
  if (process.platform !== "win32" || !/^[A-Z]:\\/.test(root) || win32.normalize(root) !== root
    || root.length > 220 || root === win32.parse(root).root || resolve(root) !== root) denied();
  if (!supplied || Object.keys(supplied).sort().join(",") !== [...names].sort().join(",")) denied();
  const pins = Object.fromEntries(names.map(name => {
    const pin = supplied[name];
    if (!pin || Object.keys(pin).sort().join(",") !== "bytes,sha256" || !Number.isSafeInteger(pin.bytes)
      || pin.bytes < 1 || pin.bytes > 4 * 1024 ** 2 || !/^[a-f0-9]{64}$/.test(pin.sha256)) denied();
    return [name, Object.freeze({ ...pin })];
  })) as NativeMcpHelperPins;
  await verify(root, pins);
  return Object.freeze({
    async identity(signal?: AbortSignal) {
      signal?.throwIfAborted(); await verify(root, pins); signal?.throwIfAborted();
      return queryNativeMainIdentity(join(root, names[0]));
    },
    async operate(operation: NativeBootstrapOperation, file: string, bytes?: Buffer, signal?: AbortSignal, deadline?: number) {
      signal?.throwIfAborted(); requireNativeOperationDeadline(deadline);
      await verify(root, pins); signal?.throwIfAborted(); requireNativeOperationDeadline(deadline);
      return runNativeBootstrapOperation(join(root, names[1]), operation, file, bytes, signal, deadline);
    },
  });
}
export type NativeMcpHelpers = Awaited<ReturnType<typeof loadNativeMcpHelpers>>;
