import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { planObservingMigration } from "./observing-migration.js";
import { ObservingMigrationWire } from "./observing-migration-wire.js";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest();
function document(revision = 7, name = "Synthetic migration site"): Buffer {
  const state = { revision, places: [{ id: "site-00000000-0000-4000-8000-000000000001", name,
    observer: { latitudeDeg: 0, longitudeDeg: 0, elevationMeters: 0 }, timeZone: "UTC" }], activePlaceId: "site-00000000-0000-4000-8000-000000000001" };
  return Buffer.from(JSON.stringify({ schemaVersion: 1, state, sha256: hash(Buffer.from(JSON.stringify(state))).toString("hex") }) + "\n");
}
const sourceBody = (bytes: Buffer, mode = 0, origin = 0) => Buffer.concat([Buffer.from([1, mode, origin, 0]), bytes]);
const destinationBody = (bytes: Buffer | null) => Buffer.concat([Buffer.from([1, bytes ? 1 : 0, 0, 0]), bytes ?? Buffer.alloc(0)]);
function decision(source: Buffer, destination: Buffer | null, mode = 0, origin = 0) {
  const wire = new ObservingMigrationWire(); wire.acceptSource(sourceBody(source, mode, origin));
  return { wire, bytes: wire.decide(destinationBody(destination)) };
}
function expectDecision(bytes: Buffer, action: number, source: Buffer, destination: Buffer | null) {
  expect(bytes).toHaveLength(68); expect([...bytes.subarray(0, 4)]).toEqual([1, action, destination ? 1 : 0, 0]);
  expect(bytes.subarray(4, 36)).toEqual(hash(source)); expect(bytes.subarray(36)).toEqual(destination ? hash(destination) : Buffer.alloc(32));
}

it("emits a fixed hash-bound copy decision without returning private source bytes", () => {
  const source = document(), { wire, bytes } = decision(source, null, 0, 1);
  expectDecision(bytes, 1, source, null); expect(source).toEqual(document()); expect(wire.complete).toBe(false);
  wire.acceptMigrated(Buffer.from([1, 1])); expect(wire.complete).toBe(true);
});
it("allows only byte-identical initial retry and blocks different valid destination revisions or serialization", () => {
  const source = document(); const same = decision(source, Buffer.from(source)); expectDecision(same.bytes, 2, source, source);
  same.wire.acceptMigrated(Buffer.from([1, 2])); expect(same.wire.complete).toBe(true);
  for (const destination of [document(6), document(8), Buffer.concat([source, Buffer.from(" ")])]) {
    const { wire, bytes } = decision(source, destination); expectDecision(bytes, 0, source, destination); expect(wire.complete).toBe(false);
    expect(() => wire.acceptMigrated(Buffer.from([1, 2]))).toThrow("protocol");
  }
});
it("validates completed source/destination independently and permits later native edits", () => {
  const source = document(), destination = document(8, "Synthetic native edit");
  // Origin is current existing-source state, not the marker's historical origin.
  const { wire, bytes } = decision(source, destination, 1, 0); expectDecision(bytes, 3, source, destination);
  wire.acceptMigrated(Buffer.from([1, 3])); expect(wire.complete).toBe(true);
});
it("blocks missing or corrupt completed data and invalid content on either initial side", () => {
  const source = document(), bad = Buffer.from("{\"schemaVersion\":1}");
  for (const [left, right, mode] of [[source, null, 1], [bad, source, 1], [source, bad, 1], [bad, null, 0], [source, bad, 0], [bad, bad, 0]] as const) {
    const { wire, bytes } = decision(left, right, mode); expectDecision(bytes, 0, left, right); expect(wire.complete).toBe(false);
  }
});
it("rejects invalid UTF-8 even when replacement decoding would satisfy the v1 checksum", () => {
  const valid = document(7, "Synthetic \ufffd site"), replacement = Buffer.from("\ufffd"), at = valid.indexOf(replacement);
  expect(at).toBeGreaterThan(0);
  const corrupt = Buffer.concat([valid.subarray(0, at), Buffer.from([255]), valid.subarray(at + replacement.length)]);
  expect(planObservingMigration(corrupt, null).kind).toBe("copy");
  for (const [left, right, mode] of [[corrupt, null, 0], [valid, corrupt, 0], [corrupt, valid, 1], [valid, corrupt, 1]] as const) {
    expectDecision(decision(left, right, mode).bytes, 0, left, right);
  }
});
it("admits exactly 65536 raw snapshot bytes plus two four-byte prefixes", () => {
  const documentBytes = document(), raw = Buffer.concat([documentBytes, Buffer.alloc(32768 - documentBytes.length, 32)]);
  expect(sourceBody(raw).length + destinationBody(raw).length).toBe(65544);
  const { wire, bytes } = decision(raw, raw); expectDecision(bytes, 2, raw, raw); wire.acceptMigrated(Buffer.from([1, 2]));
  expect(wire.complete).toBe(true);
});
it("owns source and decision snapshots independently of later caller mutations", () => {
  const original = document(), incoming = sourceBody(original), wire = new ObservingMigrationWire(); wire.acceptSource(incoming); incoming.fill(255);
  const destination = destinationBody(original), bytes = wire.decide(destination); destination.fill(0);
  expectDecision(bytes, 2, original, original); wire.acceptMigrated(Buffer.from([1, 2])); expect(wire.complete).toBe(true);
});

const invalidSources = [Buffer.alloc(4), sourceBody(Buffer.alloc(32769)), sourceBody(document(), 2), sourceBody(document(), 0, 2),
  Buffer.concat([Buffer.from([2, 0, 0, 0]), document()]), Buffer.concat([Buffer.from([1, 0, 0, 1]), document()])];
it.each(invalidSources)("rejects malformed/oversized SOURCE prefix without permitting a retry", body => {
  const wire = new ObservingMigrationWire(); expect(() => wire.acceptSource(body)).toThrow("protocol"); expect(wire.complete).toBe(false);
  expect(() => wire.acceptSource(sourceBody(document()))).toThrow("protocol");
});
const invalidDestinations = [Buffer.alloc(3), destinationBody(Buffer.alloc(32769)), Buffer.from([1, 1, 0, 0]), Buffer.from([1, 0, 0, 0, 32]),
  Buffer.from([2, 0, 0, 0]), Buffer.from([1, 2, 0, 0]), Buffer.from([1, 0, 1, 0]), Buffer.from([1, 0, 0, 1])];
it.each(invalidDestinations)("rejects malformed/oversized DESTINATION prefix", body => {
  const wire = new ObservingMigrationWire(); wire.acceptSource(sourceBody(document())); expect(() => wire.decide(body)).toThrow("protocol");
});
it("rejects missing, duplicate and reordered control messages", () => {
  expect(() => new ObservingMigrationWire().decide(destinationBody(null))).toThrow("protocol");
  expect(() => new ObservingMigrationWire().acceptMigrated(Buffer.from([1, 1]))).toThrow("protocol");
  const source = new ObservingMigrationWire(); source.acceptSource(sourceBody(document())); expect(() => source.acceptSource(sourceBody(document()))).toThrow("protocol");
  const paired = decision(document(), null); expect(() => paired.wire.decide(destinationBody(null))).toThrow("protocol");
  const complete = decision(document(), null); complete.wire.acceptMigrated(Buffer.from([1, 1])); expect(() => complete.wire.acceptMigrated(Buffer.from([1, 1]))).toThrow("protocol");
});
it.each([Buffer.alloc(0), Buffer.from([1]), Buffer.from([1, 1, 0]), Buffer.from([2, 1]), Buffer.from([1, 0]), Buffer.from([1, 2]), Buffer.from([1, 3])])("requires the exact positive MIGRATED outcome", body => {
  const { wire } = decision(document(), null); expect(() => wire.acceptMigrated(body)).toThrow("protocol"); expect(wire.complete).toBe(false);
});
it("cannot complete a cancelled handshake", () => {
  const wire = new ObservingMigrationWire(); wire.acceptSource(sourceBody(document())); wire.cancel();
  expect(() => wire.decide(destinationBody(null))).toThrow("protocol"); expect(wire.complete).toBe(false);
});
