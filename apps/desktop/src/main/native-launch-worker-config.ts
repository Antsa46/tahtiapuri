import { win32 } from "node:path";

export interface NativeLaunchWorkerConfig {
  readonly schema: 1;
  readonly pid: number;
  readonly identity: string;
  readonly bootstrap: string;
  readonly broker: string;
  readonly controlFile: string;
  readonly env: Readonly<Record<string, string>>;
}
/** Closed structured-clone records only; no getters/prototypes or command API. */
export function launchRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Reflect.ownKeys(value).length === Object.keys(value).length
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => "value" in descriptor);
}
export function launchKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  const keys = Object.keys(value); return keys.length === names.length && names.every(name => Object.hasOwn(value, name));
}
export function nativeLaunchPath(value: unknown, leaf: string): value is string {
  if (typeof value !== "string" || value.length > 1800 || !/^[A-Z]:\\/.test(value)
    || win32.normalize(value) !== value || win32.basename(value) !== leaf) return false;
  return value.slice(3).split("\\").every(part => !!part && !/[. ]$/.test(part) && !/[\x00-\x1f"<>|?*:]/.test(part)
    && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *$/i.test(part.split(".")[0]!));
}
/** Shape is not package approval. Main must first verify these exact program
 * bytes and the new recover-grant protocol against independently trusted pins. */
export function nativeLaunchWorkerConfig(value: unknown): NativeLaunchWorkerConfig {
  if (!launchRecord(value) || !launchKeys(value, ["schema", "pid", "identity", "bootstrap", "broker", "controlFile", "env"])
    || value.schema !== 1 || value.pid !== process.pid
    || !nativeLaunchPath(value.identity, "main-identity.exe") || !nativeLaunchPath(value.bootstrap, "main-bootstrap.exe")
    || !nativeLaunchPath(value.broker, "mcp-broker.exe") || !nativeLaunchPath(value.controlFile, "main-bootstrap.bin")
    || !launchRecord(value.env) || Object.keys(value.env).some(key => !["SystemRoot", "WINDIR", "TEMP", "TMP"].includes(key))
    || Object.values(value.env).some(item => typeof item !== "string" || item.length > 32767 || item.includes("\0"))
    || typeof value.env.SystemRoot !== "string" || win32.normalize(value.env.SystemRoot) !== value.env.SystemRoot || !nativeLaunchPath(win32.join(value.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), "powershell.exe"))
    throw new Error("Invalid bound native launch configuration");
  const root = win32.dirname(win32.dirname(value.identity));
  if (value.identity !== win32.join(root, "helpers/main-identity.exe")
    || value.bootstrap !== win32.join(root, "helpers/main-bootstrap.exe") || value.broker !== win32.join(root, "bin/mcp-broker.exe"))
    throw new Error("Native launch programs do not share their fixed package");
  const rel = win32.relative(root, value.controlFile);
  if (rel === "" || !win32.isAbsolute(rel) && rel !== ".." && !rel.startsWith("..\\"))
    throw new Error("Native control file overlaps its program package");
  return Object.freeze({ schema: 1, pid: process.pid, identity: value.identity, bootstrap: value.bootstrap,
    broker: value.broker, controlFile: value.controlFile, env: Object.freeze({ ...value.env }) as Readonly<Record<string, string>> });
}
