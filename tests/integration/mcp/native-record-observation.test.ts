import { afterAll, beforeAll, expect, it } from "vitest";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { observeNativeRecord, type NativeRecordKind } from "../../support/mcp/native-record-observation.js";

let root: string, sequence = 0;
beforeAll(async () => {
  await mkdir(".artifacts/tests", { recursive: true });
  root = await mkdtemp(join(".artifacts/tests", "native-record-observation-"));
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
const examples: [NativeRecordKind, string, number, number][] = [
  ["session", "TMCSES1\0", 1, 1024], ["journal", "TMCJRN2\0", 2, 1024],
  ["clean-intent", "TMCCLS1\0", 1, 2048], ["clean-completion", "TMCCLD1\0", 1, 1024],
];
function reseal(bytes: Buffer) {
  createHash("sha256").update(bytes.subarray(0, bytes.length - 32)).digest().copy(bytes, bytes.length - 32);
  return bytes;
}
function example([, magic, version, size]: typeof examples[number] = examples[0]!) {
  const bytes = Buffer.alloc(size); bytes.write(magic, 0, "ascii");
  bytes.writeUInt32LE(version, 8); bytes.writeUInt32LE(size, 12);
  bytes[31] = 0x5a; // Synthetic payload is returned for the caller's context checks.
  return reseal(bytes);
}
async function fixture(bytes: Buffer) {
  const path = join(root, "record-" + (++sequence) + ".bin");
  await writeFile(path, bytes, { flag: "wx" }); return path;
}
for (const entry of examples) it("observes the complete " + entry[0] + " record without changing it", async () => {
  const bytes = example(entry), path = await fixture(bytes), result = await observeNativeRecord(path, entry[0]);
  expect(result.bytes).toEqual(bytes); expect(result.stat.size).toBe(BigInt(bytes.length));
  expect(await readFile(path)).toEqual(bytes);
});
for (const size of [0, 1023, 1025, 2047, 2049]) it("rejects a file of " + size + " bytes", async () => {
  const path = await fixture(Buffer.alloc(size));
  await expect(observeNativeRecord(path, size >= 2047 ? "clean-intent" : "session")).rejects.toThrow("Invalid native record shape");
});
for (const field of ["magic", "version", "size"] as const) it("rejects a rechecksummed wrong " + field, async () => {
  const bytes = example();
  if (field === "magic") bytes[0] = 0;
  if (field === "version") bytes.writeUInt32LE(99, 8);
  if (field === "size") bytes.writeUInt32LE(2048, 12);
  const path = await fixture(reseal(bytes));
  await expect(observeNativeRecord(path, "session")).rejects.toThrow("Invalid native record header");
});
it("rejects a changed payload without a matching checksum", async () => {
  const bytes = example(); bytes[31] = 0; const path = await fixture(bytes);
  await expect(observeNativeRecord(path, "session")).rejects.toThrow("Invalid native record checksum");
});
it("rejects a directory", async () => {
  await expect(observeNativeRecord(root, "session")).rejects.toThrow("Invalid native record shape");
});
it("rejects a multiply linked file", async () => {
  const path = await fixture(example()), alias = join(root, "alias.bin"); await link(path, alias);
  await expect(observeNativeRecord(path, "session")).rejects.toThrow("Invalid native record shape");
});
it("preserves a missing-file failure", async () => {
  await expect(observeNativeRecord(join(root, "missing.bin"), "session")).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects an unknown format before opening a file", async () => {
  await expect(observeNativeRecord(join(root, "missing.bin"), "unknown" as NativeRecordKind)).rejects.toThrow("Unknown native record format");
});
