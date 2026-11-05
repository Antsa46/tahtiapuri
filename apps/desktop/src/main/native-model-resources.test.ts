import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, lstat, rm, link, symlink, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { NATIVE_RUNTIME_FILES, NativePreparationError, prepareNativeResources, type NativeResourceConfig } from "./native-model-resources.js";
vi.mock("node:os", () => ({ freemem: () => 12 * 1024 ** 3 }));
let base: string, config: NativeResourceConfig, manifest: Record<string, unknown>;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
beforeEach(async () => {
  base = resolve(".artifacts/tests/native-resources", randomUUID());
  const runtimeRoot = join(base, "runtime"), model = "synthetic model";
  await mkdir(join(runtimeRoot, "bin"), { recursive: true });
  const files: Record<string, unknown> = {};
  for (const name of NATIVE_RUNTIME_FILES) {
    const data = "synthetic runtime " + name; await writeFile(join(runtimeRoot, "bin", name), data);
    files[name] = { bytes: Buffer.byteLength(data), sha256: digest(data) };
  }
  await writeFile(join(base, "model.gguf"), model);
  config = { runtimeRoot, workRoot: join(base, "private-work"), model: { file: join(base, "model.gguf"), bytes: model.length,
    sha256: digest(model), templateSha256: "a".repeat(64) } };
  manifest = { schema: 1, id: "tahtiapuri-native-cpu-v1", revision: "cd959bae99ff4bed22bef2604f45241c09bbb8c8", files,
    model: { bytes: model.length, sha256: digest(model), templateSha256: "a".repeat(64) } };
  await writeFile(join(runtimeRoot, "runtime.json"), JSON.stringify(manifest));
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });
it("stages only the closed resources and removes them after explicit cleanup", async () => {
  const resources = await prepareNativeResources(config, new AbortController().signal);
  expect((await readdir(join(resources.root, "package"))).sort()).toEqual([...NATIVE_RUNTIME_FILES.filter(x => x !== "model-broker.exe"), "model.gguf"].sort());
  expect(await readFile(join(resources.root, "owner.marker"), "utf8")).toBe("TAHTIAPURI_NATIVE_CPU_V1");
  expect((await lstat(join(resources.root, "package/model.gguf"))).nlink).toBe(1);
  expect(resources.profile).toMatch(/^tahtiapuri\.model\.[a-f0-9]{32}$/);
  await resources.cleanup(); await expect(lstat(resources.root)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(config.model.file, "utf8")).toBe("synthetic model");
});
it("rejects extra manifest authority before creating a staging directory", async () => {
  await writeFile(join(config.runtimeRoot, "runtime.json"), JSON.stringify({ ...manifest, command: "not allowed" }));
  await expect(prepareNativeResources(config, new AbortController().signal)).rejects.toMatchObject({ cleanupVerified: true });
  await expect(lstat(config.workRoot)).rejects.toMatchObject({ code: "ENOENT" });
});
it("removes failed preparation after a copied runtime fails its pinned digest", async () => {
  await writeFile(join(config.runtimeRoot, "bin/model-worker.exe"), "X".repeat(Buffer.byteLength("synthetic runtime model-worker.exe")));
  await expect(prepareNativeResources(config, new AbortController().signal)).rejects.toMatchObject({ cleanupVerified: true });
  expect(await readdir(config.workRoot)).toEqual([]);
});
it("rejects an approved model hardlink instead of sharing another file", async () => {
  await link(config.model.file, join(base, "model-alias.gguf"));
  await expect(prepareNativeResources(config, new AbortController().signal)).rejects.toBeInstanceOf(NativePreparationError);
  await expect(lstat(config.workRoot)).rejects.toMatchObject({ code: "ENOENT" });
});
it("does not begin preparation for an already cancelled caller", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(prepareNativeResources(config, controller.signal)).rejects.toMatchObject({ cleanupVerified: true });
  await expect(lstat(config.workRoot)).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses a reparse point during cleanup and preserves the target", async () => {
  const resources = await prepareNativeResources(config, new AbortController().signal);
  const outside = join(base, "outside"); await mkdir(outside); await writeFile(join(outside, "keep.txt"), "synthetic sentinel");
  const junction = join(resources.root, "scratch/redirect"); await symlink(outside, junction, "junction");
  await expect(resources.cleanup()).rejects.toThrow(); expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("synthetic sentinel");
  await unlink(junction); await resources.cleanup();
});

it("does not bypass a retained stage after a new host or app instance", async () => {
  const old = await prepareNativeResources(config, new AbortController().signal);
  await expect(prepareNativeResources(config, new AbortController().signal)).rejects.toMatchObject({ cleanupVerified: false });
  expect(await readFile(join(old.root, "package/model.gguf"), "utf8")).toBe("synthetic model");
  await old.cleanup(); const next = await prepareNativeResources(config, new AbortController().signal); await next.cleanup();
});
