import { beforeEach, expect, it, vi } from "vitest";
import type { BigIntStats } from "node:fs";
import { createHash } from "node:crypto";

const ports = vi.hoisted(() => ({ lstat: vi.fn(), open: vi.fn() }));
vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  lstat: ports.lstat, open: ports.open,
}));
import { observeNativeRecord } from "../../support/mcp/native-record-observation.js";

function snapshot(overrides: Partial<BigIntStats> = {}): BigIntStats {
  return { dev: 1n, ino: 2n, size: 1024n, nlink: 1n, mtimeNs: 3n, ctimeNs: 4n,
    isFile: () => true, isSymbolicLink: () => false, ...overrides } as BigIntStats;
}
function record() {
  const bytes = Buffer.alloc(1024); bytes.write("TMCSES1\0", 0, "ascii");
  bytes.writeUInt32LE(1, 8); bytes.writeUInt32LE(1024, 12);
  createHash("sha256").update(bytes.subarray(0, 992)).digest().copy(bytes, 992);
  return bytes;
}
function makeFile() {
  let offset = 0;
  return {
    stat: vi.fn(async () => snapshot()),
    read: vi.fn(async (buffer: Buffer, at: number, length: number, _position: null) => {
      const bytesRead = Math.min(length, bytes.length - offset, chunkSize);
      bytes.copy(buffer, at, offset, offset + bytesRead); offset += bytesRead;
      return { bytesRead, buffer };
    }),
    close: vi.fn(async () => {}),
  };
}
let bytes: Buffer, chunkSize: number, file: ReturnType<typeof makeFile>;
beforeEach(() => {
  ports.lstat.mockReset(); ports.open.mockReset();
  bytes = record(); chunkSize = 2048; file = makeFile();
  ports.lstat.mockResolvedValue(snapshot()); ports.open.mockResolvedValue(file);
});
it("assembles partial reads and closes the one opened handle", async () => {
  chunkSize = 127;
  expect((await observeNativeRecord("synthetic", "session")).bytes).toEqual(bytes);
  expect(file.read.mock.calls.length).toBeGreaterThan(2);
  expect(file.close).toHaveBeenCalledTimes(1); expect(ports.open).toHaveBeenCalledTimes(1);
});
it("rejects replacement between the name query and opened handle", async () => {
  file.stat.mockResolvedValueOnce(snapshot({ ino: 99n }));
  await expect(observeNativeRecord("synthetic", "session")).rejects.toThrow("changed during observation");
  expect(file.read).not.toHaveBeenCalled(); expect(file.close).toHaveBeenCalledTimes(1);
});
it("rejects an opened file changing during the read", async () => {
  file.stat.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot({ ctimeNs: 99n }));
  await expect(observeNativeRecord("synthetic", "session")).rejects.toThrow("changed during observation");
  expect(file.close).toHaveBeenCalledTimes(1);
});
it("rejects the final name referring to a replacement file", async () => {
  ports.lstat.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot({ ino: 99n }));
  await expect(observeNativeRecord("synthetic", "session")).rejects.toThrow("changed during observation");
  expect(file.close).toHaveBeenCalledTimes(1);
});
it("closes the handle after a read error", async () => {
  const failure = new Error("synthetic read error"); file.read.mockRejectedValueOnce(failure);
  await expect(observeNativeRecord("synthetic", "session")).rejects.toBe(failure);
  expect(file.close).toHaveBeenCalledTimes(1);
});
it("closes the handle after premature EOF", async () => {
  bytes = bytes.subarray(0, 100);
  await expect(observeNativeRecord("synthetic", "session")).rejects.toThrow("Invalid native record length");
  expect(file.close).toHaveBeenCalledTimes(1);
});
it("bounds a growing file to expected bytes plus one", async () => {
  bytes = Buffer.concat([bytes, Buffer.alloc(10000)]);
  await expect(observeNativeRecord("synthetic", "session")).rejects.toThrow("Invalid native record length");
  expect(file.read).toHaveBeenCalledTimes(1);
  expect(file.read.mock.calls[0]![2]).toBe(1025); expect(file.close).toHaveBeenCalledTimes(1);
});
it("closes the handle after checksum rejection", async () => {
  bytes[31] = 0x5a;
  await expect(observeNativeRecord("synthetic", "session")).rejects.toThrow("Invalid native record checksum");
  expect(file.close).toHaveBeenCalledTimes(1);
});
function gate() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
it("does not return success until the close finishes", async () => {
  const entered = gate(), release = gate(); let settled = false;
  file.close.mockImplementation(async () => { entered.resolve(); await release.promise; });
  const observation = observeNativeRecord("synthetic", "session");
  void observation.then(() => { settled = true; });
  try {
    await entered.promise; expect(settled).toBe(false); release.resolve();
    expect((await observation).bytes).toEqual(bytes); expect(settled).toBe(true);
  } finally { release.resolve(); await observation; }
});
it("rejects a close failure instead of returning an accepted observation", async () => {
  const failure = new Error("synthetic close error"); file.close.mockRejectedValueOnce(failure);
  await expect(observeNativeRecord("synthetic", "session")).rejects.toBe(failure);
});
it("closes the handle after its metadata query fails", async () => {
  const failure = new Error("synthetic handle-stat error"); file.stat.mockRejectedValueOnce(failure);
  await expect(observeNativeRecord("synthetic", "session")).rejects.toBe(failure);
  expect(file.close).toHaveBeenCalledTimes(1);
});
it("closes the handle after the final name query fails", async () => {
  const failure = new Error("synthetic name-stat error");
  ports.lstat.mockResolvedValueOnce(snapshot()).mockRejectedValueOnce(failure);
  await expect(observeNativeRecord("synthetic", "session")).rejects.toBe(failure);
  expect(file.close).toHaveBeenCalledTimes(1);
});
