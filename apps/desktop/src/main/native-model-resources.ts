import { createReadStream, constants } from "node:fs";
import { lstat, realpath, readFile, copyFile, mkdir, rm, opendir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { freemem } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { exactKeys, isRecord } from "@tahtiapuri/validation/public";
import type { ApprovedModel } from "@tahtiapuri/validation/model-wire";
import { securePrivateDirectory, PrivateDirectoryProcessError } from "./private-directory.js";
const MARKER = "TAHTIAPURI_NATIVE_CPU_V1";
export const NATIVE_RUNTIME_FILES = ["model-broker.exe", "model-worker.exe", "ggml-base.dll", "ggml.dll", "llama.dll", "ggml-cpu.dll"] as const;
export type NativeResourceConfig = { runtimeRoot: string; workRoot: string; model: ApprovedModel };
type Identity = { bytes: number; sha256: string };
type RuntimeManifest = { files: Record<typeof NATIVE_RUNTIME_FILES[number], Identity> };
function denied(): never { throw new Error("Native runtime resources unavailable."); }
async function regular(path: string, bytes?: number) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || bytes !== undefined && info.size !== bytes
    || relative(resolve(path), await realpath(path)) !== "") return denied();
  return info;
}
async function localTree(path: string) {
  if (!isAbsolute(path) || path.startsWith("\\\\") || path.startsWith("//") || path.includes("\0")) return denied();
  let part = resolve(path);
  for (;;) {
    const info = await lstat(part);
    if (!info.isDirectory() || info.isSymbolicLink() || relative(part, await realpath(part)) !== "") return denied();
    const parent = dirname(part); if (parent === part) return;
    part = parent;
  }
}
async function hash(path: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted(); const digest = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) digest.update(chunk);
  signal.throwIfAborted(); return digest.digest("hex");
}
async function runtimeManifest(config: NativeResourceConfig): Promise<RuntimeManifest> {
  await localTree(config.runtimeRoot); await localTree(join(config.runtimeRoot, "bin"));
  await regular(join(config.runtimeRoot, "runtime.json"));
  if ((await lstat(join(config.runtimeRoot, "runtime.json"))).size > 65536) return denied();
  const value: unknown = JSON.parse(await readFile(join(config.runtimeRoot, "runtime.json"), "utf8"));
  if (!isRecord(value) || !exactKeys(value, ["schema", "id", "revision", "files", "model"]) || value.schema !== 1
    || value.id !== "tahtiapuri-native-cpu-v1" || value.revision !== "cd959bae99ff4bed22bef2604f45241c09bbb8c8"
    || !isRecord(value.files) || !exactKeys(value.files, [...NATIVE_RUNTIME_FILES]) || !isRecord(value.model)
    || !exactKeys(value.model, ["bytes", "sha256", "templateSha256"]) || value.model.bytes !== config.model.bytes
    || value.model.sha256 !== config.model.sha256 || value.model.templateSha256 !== config.model.templateSha256) return denied();
  for (const name of NATIVE_RUNTIME_FILES) {
    const file = value.files[name];
    if (!isRecord(file) || !exactKeys(file, ["bytes", "sha256"]) || typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes)
      || file.bytes <= 0 || file.bytes > 16 * 1024 ** 2 || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) return denied();
  }
  return value as RuntimeManifest;
}
async function noLinks(path: string, budget = { entries: 0 }, depth = 0): Promise<void> {
  if (++budget.entries > 512 || depth > 8) return denied();
  const info = await lstat(path); if (info.isSymbolicLink()) return denied();
  if (info.isDirectory()) {
    const directory = await opendir(path);
    for await (const entry of directory) await noLinks(join(path, entry.name), budget, depth + 1);
  }
}
export type PreparedNativeResources = { root: string; broker: string; profile: string; cleanup(): Promise<void> };
export class NativePreparationError extends Error {
  constructor(readonly cleanupVerified: boolean) { super("Native runtime preparation failed."); }
}
export async function prepareNativeResources(config: NativeResourceConfig, signal: AbortSignal): Promise<PreparedNativeResources> {
  try { return await prepare(config, signal); }
  catch (error) {
    if (error instanceof NativePreparationError) throw error;
    throw new NativePreparationError(!(error instanceof PrivateDirectoryProcessError) || error.exitVerified);
  }
}
async function prepare(config: NativeResourceConfig, signal: AbortSignal): Promise<PreparedNativeResources> {
  signal.throwIfAborted();
  if (!isAbsolute(config.workRoot) || resolve(config.workRoot) !== config.workRoot) return denied();
  if (freemem() < 6 * 1024 ** 3) return denied();
  const manifest = await runtimeManifest(config); signal.throwIfAborted();
  await localTree(dirname(config.model.file)); await regular(config.model.file, config.model.bytes);
  // This parent is main-owned, outside the model's readable package tree.
  await securePrivateDirectory(config.workRoot, signal); await localTree(config.workRoot); signal.throwIfAborted();
  // A retained stage is persistent evidence of unverified old ownership. A new
  // host/app instance must not bypass the previous instance's in-memory taint.
  const existing = await opendir(config.workRoot);
  let retained: boolean;
  try { retained = await existing.read() !== null; } finally { await existing.close(); }
  if (retained) throw new NativePreparationError(false);
  const id = randomUUID().replaceAll("-", ""), root = join(config.workRoot, id);
  await mkdir(root);
  async function remove(checkMarker: boolean) {
    await localTree(config.workRoot); await localTree(root);
    if (dirname(root) !== config.workRoot || checkMarker && await readFile(join(root, "owner.marker"), "utf8") !== MARKER) return denied();
    await noLinks(root); await rm(root, { recursive: true });
  }
  try {
    signal.throwIfAborted();
    await writeFile(join(root, "owner.marker"), MARKER, { flag: "wx" });
    for (const directory of ["launcher", "package", "private", "scratch"]) { signal.throwIfAborted(); await mkdir(join(root, directory)); }
    await writeFile(join(root, "private/secret.txt"), "synthetic handle inheritance sentinel", { flag: "wx" });
    for (const name of NATIVE_RUNTIME_FILES) {
      signal.throwIfAborted();
      const source = join(config.runtimeRoot, "bin", name), destination = join(root, name === "model-broker.exe" ? "launcher" : "package", name);
      await regular(source, manifest.files[name].bytes);
      await copyFile(source, destination, constants.COPYFILE_EXCL); signal.throwIfAborted();
      await regular(destination, manifest.files[name].bytes);
      if (await hash(destination, signal) !== manifest.files[name].sha256) return denied();
    }
    signal.throwIfAborted();
    await copyFile(config.model.file, join(root, "package/model.gguf"), constants.COPYFILE_EXCL); signal.throwIfAborted();
    await regular(join(root, "package/model.gguf"), config.model.bytes);
    // Native broker hashes model+DLLs while holding write/delete-excluding pins.
    return { root, broker: join(root, "launcher/model-broker.exe"), profile: "tahtiapuri.model." + id,
      cleanup: () => remove(true) };
  } catch {
    // No broker has been launched on this path. Await every filesystem operation
    // before cleanup; a cancellation must never resume later and create a worker.
    try { await remove(false); } catch { throw new NativePreparationError(false); }
    throw new NativePreparationError(true);
  }
}
