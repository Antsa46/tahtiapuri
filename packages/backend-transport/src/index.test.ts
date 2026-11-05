import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { BoundedWriter, FrameReader, HEADER, KINDS, TRANSPORT_POLICY, decodeJson, encodeJson, frame, type Frame } from "./index.js";

const nonce = "a".repeat(64), options = { nonce, allowedKinds: [KINDS.APP], maxPayloadBytes: TRANSPORT_POLICY.childOutputBytes };
const encoded = (sequence = 1n, body = Buffer.from("tähti")) => frame(KINDS.APP, sequence, nonce, body);
function collect(reader: FrameReader, bytes: Buffer): Frame[] { const records: Frame[] = []; reader.push(bytes, record => records.push(record)); return records; }
class HeldStream extends EventEmitter {
  writes: Buffer[] = [];
  callbacks: ((error?: Error | null) => void)[] = [];
  destroyed = false;
  writableEnded = false;
  backpressure = false;
  write(bytes: Buffer, callback: (error?: Error | null) => void): boolean { this.writes.push(Buffer.from(bytes)); this.callbacks.push(callback); return !this.backpressure; }
  release(error?: Error): void { this.callbacks.shift()?.(error); }
  end(callback: (error?: Error | null) => void): void { this.writableEnded = true; queueMicrotask(() => { callback(); this.emit("finish"); this.emit("close"); }); }
}
const heldWriter = (stream: HeldStream, allowedKinds: number[] = [KINDS.APP], onFailure?: (error: Error) => void) =>
  new BoundedWriter(stream as unknown as Writable, { ...options, allowedKinds, ...(onFailure ? { onFailure } : {}) });
afterEach(() => vi.useRealTimers());

it("uses only production TBIP v2, a zero reserved word and uint64 binary sequences", () => {
  const bytes = encoded();
  expect(HEADER).toBe(56); expect(bytes.readUInt16LE(4)).toBe(2); expect(bytes.readBigUInt64LE(8)).toBe(1n);
  expect(bytes.readUInt32LE(16)).toBe(Buffer.byteLength("tähti")); expect(bytes.readUInt32LE(20)).toBe(0);
  expect(bytes.subarray(24, HEADER)).toEqual(Buffer.from(nonce, "hex"));
  for (const mutate of [(b: Buffer) => b.writeUInt16LE(1, 4), (b: Buffer) => b.writeUInt32LE(1, 20)]) {
    const bad = Buffer.from(bytes); mutate(bad); expect(() => collect(new FrameReader(options), bad)).toThrow();
  }
});
it("fragments, coalesces and resets bounded buffers, including empty frames", () => {
  const reader = new FrameReader(options), records: Frame[] = [];
  for (const byte of encoded()) reader.push(Buffer.from([byte]), record => records.push(record));
  reader.push(Buffer.concat([encoded(2n, Buffer.alloc(0)), encoded(3n)]), record => records.push(record));
  expect(records.map(row => [row.sequence, row.body.toString()])).toEqual([[1n, "tähti"], [2n, ""], [3n, "tähti"]]); reader.finish();
  expect(() => reader.push(Buffer.alloc(0), () => {})).toThrow();
});
it("rejects invalid canonical header fields before payload allocation and remains failed", () => {
  for (const mutate of [
    (b: Buffer) => { b[0] = 255; }, (b: Buffer) => { b[24] = 0; }, (b: Buffer) => b.writeUInt16LE(KINDS.KILL, 6),
    (b: Buffer) => b.writeBigUInt64LE(0n, 8), (b: Buffer) => b.writeBigUInt64LE(2n, 8),
    (b: Buffer) => b.writeUInt32LE(TRANSPORT_POLICY.childOutputBytes + 1, 16),
  ]) {
    const reader = new FrameReader(options), bytes = encoded(); mutate(bytes);
    expect(() => collect(reader, bytes.subarray(0, HEADER))).toThrow();
    expect((reader as unknown as { body?: Buffer }).body).toBeUndefined(); expect(() => reader.finish()).toThrow();
    expect(() => collect(reader, encoded())).toThrow();
  }
  for (const badNonce of ["A".repeat(64), "a".repeat(63), "a".repeat(66)]) expect(() => new FrameReader({ ...options, nonce: badNonce })).toThrow();
});
it("detects partial header/payload EOF and callback exceptions permanently", () => {
  for (const length of [1, HEADER - 1, HEADER, HEADER + 1]) {
    const reader = new FrameReader(options); collect(reader, encoded().subarray(0, length));
    expect(() => reader.finish()).toThrow(); expect(() => collect(reader, encoded())).toThrow();
  }
  const reader = new FrameReader(options); expect(() => reader.push(encoded(), () => { throw new Error("consumer failed"); })).toThrow("consumer failed");
  expect(() => reader.finish()).toThrow("consumer failed");
});
it("poisons reentrant pushes even when the delivery callback catches their error", () => {
  for (const nestedBytes of [encoded(2n), Buffer.from([255]), Buffer.alloc(0)]) {
    const reader = new FrameReader(options), delivered: bigint[] = [];
    expect(() => reader.push(Buffer.concat([encoded(), encoded(2n)]), record => {
      delivered.push(record.sequence);
      expect(() => reader.push(nestedBytes, nested => delivered.push(nested.sequence))).toThrow("Reentrant");
    })).toThrow("Reentrant");
    expect(delivered).toEqual([1n]); expect(() => reader.finish()).toThrow("Reentrant");
    expect(() => collect(reader, encoded(2n))).toThrow("Reentrant");
  }
});
it("delivers no later coalesced frames when a callback finishes its reader", () => {
  const reader = new FrameReader(options), delivered: bigint[] = [];
  expect(() => reader.push(Buffer.concat([encoded(), encoded(2n)]), record => { delivered.push(record.sequence); reader.finish(); })).toThrow("finished during delivery");
  expect(delivered).toEqual([1n]); expect(() => reader.finish()).toThrow(); expect(() => collect(reader, encoded(2n))).toThrow();
});
it("recognizes empty outer HEARTBEAT while rejecting it on the APP-only worker channel", () => {
  const bytes = frame(KINDS.HEARTBEAT, 1n, nonce), owner = new FrameReader({ ...options, allowedKinds: [KINDS.HEARTBEAT] });
  expect(KINDS.HEARTBEAT).toBe(5); expect(collect(owner, bytes)).toMatchObject([{ kind: 5, sequence: 1n, body: Buffer.alloc(0) }]); owner.finish();
  expect(() => collect(new FrameReader(options), bytes)).toThrow();
  expect(() => frame(KINDS.HEARTBEAT, 1n, nonce, Buffer.from("x"))).toThrow();
  const nonempty = Buffer.from(bytes); nonempty.writeUInt32LE(1, 16);
  expect(() => collect(new FrameReader({ ...options, allowedKinds: [KINDS.HEARTBEAT] }), nonempty)).toThrow();
});
it("handles a maximum payload with one-byte fragmentation without retaining records", () => {
  const body = Buffer.alloc(65_536, 88), bytes = encoded(1n, body), reader = new FrameReader(options); let count = 0;
  for (let offset = 0; offset < bytes.length; offset++) reader.push(bytes.subarray(offset, offset + 1), record => { expect(record.body).toEqual(body); count++; });
  reader.finish(); expect(count).toBe(1); expect((reader as unknown as { body?: Buffer }).body).toBeUndefined();
});
it("has no 256 frame, 64 MiB or 2048 chunk lifetime quota", async () => {
  const reader = new FrameReader(options), body = Buffer.alloc(128 * 1024, 88); let frames = 0;
  const stream = new Writable({ write(bytes: Buffer, _encoding, callback) {
    for (let offset = 0; offset < bytes.length; offset += 8192) reader.push(bytes.subarray(offset, offset + 8192), record => { expect(record.body.length).toBe(body.length); frames++; });
    callback();
  } });
  const writer = new BoundedWriter(stream, options);
  for (let count = 0; count < 513; count++) await writer.send(KINDS.APP, body);
  await writer.end(); reader.finish(); expect(frames).toBe(513);
});
it("accepts a full child-output frame and independently enforces the owner-input cap", () => {
  const bytes = encoded(1n, Buffer.alloc(TRANSPORT_POLICY.childOutputBytes, 88)), reader = new FrameReader(options); let count = 0;
  for (let offset = 0; offset < bytes.length; offset += 4096) reader.push(bytes.subarray(offset, offset + 4096), record => { expect(record.body.length).toBe(TRANSPORT_POLICY.childOutputBytes); count++; });
  reader.finish(); expect(count).toBe(1);
  const ownerReader = new FrameReader({ ...options, maxPayloadBytes: TRANSPORT_POLICY.ownerInputBytes });
  expect(() => ownerReader.push(bytes.subarray(0, HEADER), () => {})).toThrow();
});
it("rejects uint64 wrap for reader and writer before emitting another frame", async () => {
  const max = 0xffff_ffff_ffff_ffffn, reader = new FrameReader(options);
  (reader as unknown as { sequence: bigint }).sequence = max;
  expect(collect(reader, encoded(max))[0]!.sequence).toBe(max); expect(() => collect(reader, encoded(1n))).toThrow();
  const stream = new HeldStream(), writer = heldWriter(stream); (writer as unknown as { sequence: bigint }).sequence = max;
  const last = writer.send(KINDS.APP, Buffer.alloc(0)); stream.release(); await last;
  await expect(writer.send(KINDS.APP, Buffer.alloc(0))).rejects.toThrow(); expect(stream.writes).toHaveLength(1);
});
it("strictly decodes UTF-8 JSON and counts encoded bytes", () => {
  const body = encodeJson({ text: "tähti\ud800" }, 100); expect(decodeJson(body)).toEqual({ text: "tähti\ud800" });
  expect(() => encodeJson({ text: "tähti\ud800" }, body.length - 1)).toThrow(); expect(() => encodeJson(undefined, 100)).toThrow();
  for (const bytes of [Buffer.from([255]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xe2, 0x82]), Buffer.from("\ufeff{}"), Buffer.from("{")]) expect(() => decodeJson(bytes)).toThrow();
});
it("freezes queued bodies and waits for both callback and backpressure drain in either order", async () => {
  for (const drainFirst of [false, true]) {
    const stream = new HeldStream(); stream.backpressure = true; const writer = heldWriter(stream), body = Buffer.from("a");
    const first = writer.send(KINDS.APP, body), second = writer.send(KINDS.APP, body); body[0] = 120;
    let completed = false; void first.then(() => { completed = true; });
    if (drainFirst) stream.emit("drain"); else stream.release(); await Promise.resolve(); expect(completed).toBe(false);
    if (drainFirst) stream.release(); else stream.emit("drain"); await first; await Promise.resolve();
    stream.release(); stream.emit("drain"); await second; await writer.end();
    expect(collect(new FrameReader(options), Buffer.concat(stream.writes)).map(row => row.body.toString())).toEqual(["a", "a"]);
  }
});
it("bounds active plus queued messages and bytes and rejects every pending operation on overflow", async () => {
  for (const bytes of [1, TRANSPORT_POLICY.childOutputBytes]) {
    const stream = new HeldStream(), writer = heldWriter(stream), promises: Promise<unknown>[] = [];
    const count = bytes === 1 ? 33 : 3;
    for (let index = 0; index < count; index++) promises.push(writer.send(KINDS.APP, Buffer.alloc(bytes)));
    promises.push(writer.drain(), writer.end());
    expect((await Promise.allSettled(promises)).every(row => row.status === "rejected")).toBe(true);
    stream.release(); await expect(writer.send(KINDS.APP, Buffer.alloc(0))).rejects.toThrow();
  }
});
it("bounds absent callbacks, absent drain and end progress at two seconds", async () => {
  vi.useFakeTimers();
  for (const missing of ["callback", "drain", "end"]) {
    const stream = new HeldStream(), writer = heldWriter(stream); stream.backpressure = missing === "drain";
    if (missing === "end") stream.end = () => {};
    const pending = missing === "end" ? writer.end() : writer.send(KINDS.APP, Buffer.from("x"));
    const observed = Promise.allSettled([pending, writer.drain()]);
    if (missing === "drain") stream.release();
    await vi.advanceTimersByTimeAsync(2000); expect((await observed)[0]!.status).toBe("rejected");
    await expect(writer.drain()).rejects.toThrow(); stream.release(); stream.emit("drain"); stream.emit("error", new Error("late"));
  }
});
it("keeps errors sticky through later RESULT and consumes late callbacks and stream errors", async () => {
  for (const event of ["error", "close"]) {
    const stream = new HeldStream(), failures: Error[] = [], writer = heldWriter(stream, [KINDS.APP, KINDS.RESULT], error => failures.push(error));
    const pending = Promise.allSettled([writer.send(KINDS.APP, Buffer.from("a")), writer.send(KINDS.RESULT, Buffer.from("b")), writer.drain(), writer.end()]);
    stream.emit(event, new Error("first failure")); expect((await pending).every(row => row.status === "rejected")).toBe(true);
    stream.release(new Error("late callback")); stream.emit("error", new Error("late stream"));
    await expect(writer.send(KINDS.RESULT, Buffer.from("success"))).rejects.toThrow(); expect(failures).toHaveLength(1);
  }
});
it("rejects active, queued and flush promises on write-callback or end-callback errors", async () => {
  const stream = new HeldStream(), writer = heldWriter(stream);
  const pending = Promise.allSettled([writer.send(KINDS.APP, Buffer.from("a")), writer.send(KINDS.APP, Buffer.from("b")), writer.drain(), writer.end()]);
  stream.release(new Error("callback failure")); expect((await pending).every(row => row.status === "rejected")).toBe(true);
  const endStream = new HeldStream(); endStream.end = callback => queueMicrotask(() => callback(new Error("end failure")));
  const ending = heldWriter(endStream); await expect(ending.end()).rejects.toThrow("end failure"); await expect(ending.drain()).rejects.toThrow("end failure");
});
it("snapshots frame options and keeps a single flush waiter for repeated drain calls", async () => {
  const stream = new HeldStream(), configuration = { ...options, allowedKinds: [KINDS.APP] }, writer = new BoundedWriter(stream as unknown as Writable, configuration);
  configuration.nonce = "b".repeat(64); configuration.allowedKinds.length = 0; configuration.maxPayloadBytes = 0;
  const pending = writer.send(KINDS.APP, Buffer.from("a")), firstDrain = writer.drain(); expect(writer.drain()).toBe(firstDrain);
  stream.release(); await pending; await firstDrain; await writer.end(); expect(collect(new FrameReader(options), stream.writes[0]!)[0]!.body.toString()).toBe("a");
  expect(Object.isFrozen(TRANSPORT_POLICY)).toBe(true);
});
it("rejects premature close during seal and prevents admission after end begins", async () => {
  const stream = new HeldStream(), writer = heldWriter(stream);
  const pending = Promise.allSettled([writer.send(KINDS.APP, Buffer.from("a")), writer.seal()]); stream.emit("close");
  expect((await pending).every(row => row.status === "rejected")).toBe(true);
  const endStream = new HeldStream(), ending = heldWriter(endStream), end = ending.end();
  const rejected = ending.send(KINDS.APP, Buffer.alloc(0)); expect((await Promise.allSettled([end, rejected])).every(row => row.status === "rejected")).toBe(true);
});
it("allows ordered owner peer close but rejects incomplete or unarmed closure", async () => {
  const stream = new HeldStream(), writer = heldWriter(stream, [KINDS.CLOSE_CHILD_INPUT, KINDS.KILL]);
  expect(() => writer.expectPeerClose()).toThrow(); const close = writer.send(KINDS.CLOSE_CHILD_INPUT, Buffer.alloc(0));
  expect(() => writer.expectPeerClose()).toThrow(); stream.release(); await close; writer.expectPeerClose();
  const kill = writer.send(KINDS.KILL, Buffer.alloc(0)); stream.release(); await kill;
  stream.emit("close"); await writer.seal(); expect(stream.writableEnded).toBe(false);
});
