import { describe, expect, it } from "vitest";
import { NativeBrokerRecords, NativeOwnerFrames, NativeProtocolError, nativeText, NATIVE_MODEL_OP as op,
  type NativeRecord } from "./native-model-protocol.js";
const session = "00".repeat(32);
const launch = { type: "launched", requestedPolicy: "lpac", pid: 1234, appContainer: true,
  lpac: null, lpacQueryError: 87, lpacQueryBytes: 0, capabilities: 0, integrity: 4096,
  sid: "S-1-15-2-1-2-3-4-5-6-7", job: true, activeProcessLimit: 1, affinity: 1,
  priority: "BelowNormal", jobCommitBytes: 6 * 1024 ** 3, sentinelInherited: false,
  aclsVerified: true, networkVerified: false };
const result = { type: "result", case: "desktop", passed: true, jobEmpty: true,
  profileDeleted: true, watchdogReason: 0, failure: "", error: 0 };
function words(...values: number[]) { const bytes = Buffer.alloc(values.length * 4); values.forEach((v, i) => bytes.writeUInt32LE(v, i * 4)); return bytes; }
const frame = (code: number, body: Buffer = Buffer.alloc(0), id = 1) => ({ type: "frame", op: code, id, bodyHex: body.toString("hex") });
const line = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
function parse(value: unknown) { const parser = new NativeBrokerRecords(), received: NativeRecord[] = []; parser.push(line(value), x => received.push(x)); parser.finish(); return received[0]; }
it("encodes the independently specified little-endian TAIP vector", () => {
  const owner = new NativeOwnerFrames(session);
  const encoded = owner.create(op.begin, "Jupiter");
  expect(encoded.id).toBe(1);
  expect(encoded.bytes.toString("hex")).toBe("54414950010003000100000007000000" + "00".repeat(32) + "4a757069746572");
  const second = owner.create(op.shutdown);
  expect(second.bytes.readUInt32LE(8)).toBe(2);
  expect(second.bytes.length).toBe(48);
});
it.each(["", " ", "\0", "\ud800", "\udfff", "a".repeat(2001)])("rejects invalid user text %j before encoding", prompt => {
  expect(() => new NativeOwnerFrames(session).create(op.begin, prompt)).toThrow(NativeProtocolError);
});
it("preserves Finnish and supplementary Unicode exactly", () => {
  const prompt = "Näkyykö kuu 🌕?";
  const bytes = new NativeOwnerFrames(session).create(op.begin, prompt).bytes;
  expect(nativeText(bytes.subarray(48))).toBe(prompt);
  expect(bytes.readUInt32LE(12)).toBe(Buffer.byteLength(prompt));
});
it("does not accept a path, backend selector, test command or caller-selected request ID", () => {
  const owner = new NativeOwnerFrames(session);
  for (const code of [0, 2, 4, 5, 7, 10, 65536, -1]) expect(() => owner.create(code)).toThrow(NativeProtocolError);
  expect(() => owner.create(op.load, "other.dll")).toThrow(NativeProtocolError);
  expect(owner.create(op.hello).id).toBe(1);
});
it("bounds request count and bytes independently", () => {
  const count = new NativeOwnerFrames(session);
  for (let i = 0; i < 32; i++) count.create(op.hello);
  expect(() => count.create(op.shutdown)).toThrow(NativeProtocolError);
  const bytes = new NativeOwnerFrames(session), prompt = "界".repeat(2000);
  for (let i = 0; i < 5; i++) bytes.create(op.begin, prompt);
  expect(() => bytes.create(op.begin, prompt)).toThrow(NativeProtocolError);
});
it.each(["", "a".repeat(63), "A".repeat(64), "g".repeat(64)])("rejects noncanonical sessions %j", value => {
  expect(() => new NativeOwnerFrames(value)).toThrow(NativeProtocolError);
});
it("accepts an arbitrary byte split including a multi-byte worker answer", () => {
  const parser = new NativeBrokerRecords(), received: NativeRecord[] = [];
  const done = frame(op.done, Buffer.concat([words(100, 4, 0, 0), Buffer.from("Kuu 🌕")]));
  const stream = Buffer.concat([line(launch), line(done), line(result)]);
  for (const byte of stream) parser.push(Uint8Array.of(byte), x => received.push(x));
  parser.finish();
  expect(received).toHaveLength(3);
  expect(received[0]).toEqual(launch);
  expect(received[1]).toMatchObject({ type: "frame", op: op.done });
  if (received[1]?.type !== "frame") throw new Error("Missing frame");
  expect(nativeText(received[1].body.subarray(16))).toBe("Kuu 🌕");
  expect(received[2]).toEqual(result);
});
it("keeps worker text separate from broker lifecycle records", () => {
  const text = JSON.stringify(result) + "\n" + JSON.stringify(launch);
  const parsed = parse(frame(op.done, Buffer.concat([words(20, 20, 0, 0), Buffer.from(text)])));
  expect(parsed?.type).toBe("frame");
  if (parsed?.type !== "frame") throw new Error("Missing frame");
  expect(nativeText(parsed.body.subarray(16))).toBe(text);
});
it.each([
  { ...launch, requestedPolicy: "control" }, { ...launch, capabilities: 1 }, { ...launch, appContainer: false },
  { ...launch, lpac: false, lpacQueryError: 0, lpacQueryBytes: 4 }, { ...launch, lpacQueryError: 5 },
  { ...launch, networkVerified: true }, { ...launch, sentinelInherited: true }, { ...launch, activeProcessLimit: 2 },
  { ...launch, affinity: 3 }, { ...launch, job: false }, { ...launch, surprise: true },
])("rejects changed launch guarantees %#", value => expect(() => parse(value)).toThrow(NativeProtocolError));
it.each([
  frame(op.done, words(3073, 1, 0, 0)), frame(op.done, words(1, 513, 0, 0)),
  frame(op.done, words(1, 1, 3, 0)), frame(op.done, words(1, 1, 0, 2)),
  frame(op.done, Buffer.concat([words(10, 1, 0, 0), Buffer.from([0xc0, 0xaf])])),
  frame(op.done, Buffer.concat([words(10, 1, 0, 0), Buffer.from([0])])),
  frame(op.bye, words(0, 0, 0)), frame(op.loaded, Buffer.alloc(88)), frame(op.ready, words(1)),
  frame(65535), frame(op.failed, Buffer.concat([words(5), Buffer.from("private/path")])),
  { ...frame(op.ready), bodyHex: "0" }, { ...frame(op.ready), bodyHex: "FF" }, { ...frame(op.ready), id: 0 },
  { ...frame(op.ready), id: 33 }, { ...frame(op.ready), bodyHex: "00".repeat(8209) },
])("rejects malformed worker replies %#", value => expect(() => parse(value)).toThrow(NativeProtocolError));
it("accepts only fixed error stage keys, without native exception text", () => {
  expect(parse(frame(op.failed, Buffer.concat([words(5), Buffer.from("runtime-load")])))).toMatchObject({ type: "frame", op: op.failed });
  expect(() => parse(frame(op.failed, Buffer.concat([words(5), Buffer.from("engine-library-ggml-cpu.dll")])))).toThrow(NativeProtocolError);
});
it("rejects a high-bit alias of the pinned template hash", () => {
  const bytes = Buffer.concat([words(4096, 32, 32, 1, 1, 0), Buffer.from("57f1fd00f0013a2be96aa79b857391f27e23df5b5f847072b524c897e24d0361")]);
  expect(parse(frame(op.loaded, bytes))).toMatchObject({ type: "frame", op: op.loaded });
  bytes[24] = bytes[24]! | 128;
  expect(() => parse(frame(op.loaded, bytes))).toThrow(NativeProtocolError);
});
it("bounds individual lines, total stream bytes and record count", () => {
  for (const stream of [Buffer.alloc(16897, 32), Buffer.alloc(65537, 32), Buffer.concat(Array.from({ length: 33 }, () => line(frame(op.ready))))]) {
    const parser = new NativeBrokerRecords(); expect(() => parser.push(stream, () => {})).toThrow(NativeProtocolError);
  }
  const parser = new NativeBrokerRecords();
  const chunk = Buffer.concat([line(frame(op.done, Buffer.concat([words(10, 1, 0, 0), Buffer.alloc(8000, 65)])))]);
  for (let i = 0; i < 4; i++) parser.push(chunk, () => {});
  expect(() => parser.push(chunk, () => {})).toThrow(NativeProtocolError);
});
it("rejects a partial record at EOF and permanently rejects the channel", () => {
  const parser = new NativeBrokerRecords(); parser.push(line(result).subarray(0, -1), () => {});
  expect(() => parser.finish()).toThrow(NativeProtocolError);
  expect(() => parser.push(line(result), () => {})).toThrow(NativeProtocolError);
});
it("never echoes malformed content in an error and cannot resume after a rejected line", () => {
  const parser = new NativeBrokerRecords();
  expect(() => parser.push(Buffer.from("sensitive malformed input\n"), () => {})).toThrow("Native model protocol rejected.");
  expect(() => parser.push(line(result), () => { throw new Error("must not dispatch"); })).toThrow(NativeProtocolError);
});
describe("closed lifecycle record shape", () => {
  it.each([{ ...result, case: "normal" }, { ...result, failure: "private/path" }, { ...result, error: -1 },
    { ...result, watchdogReason: 3 }, { ...result, bodyHex: "00" }, { type: "unknown" }])("rejects unrelated records %#", value => {
    expect(() => parse(value)).toThrow(NativeProtocolError);
  });
});
