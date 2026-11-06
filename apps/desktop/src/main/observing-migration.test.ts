import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { PlacesState } from "@tahtiapuri/validation/observing";
import { planObservingMigration } from "./observing-migration.js";

// Static synthetic storage-v1 fixture in JsonPlacesRepository's writer shape:
// JSON.stringify({ schemaVersion: 1, state, sha256: SHA256(JSON.stringify(state)) }) + LF.
// Two deliberately ordered place IDs and revision 7 expose accidental re-saving.
const fixture = '{"schemaVersion":1,"state":{"revision":7,"places":[{"id":"site-00000000-0000-4000-8000-000000000002","name":"Synthetic second site","observer":{"latitudeDeg":0,"longitudeDeg":0,"elevationMeters":0},"timeZone":"UTC"},{"id":"site-00000000-0000-4000-8000-000000000001","name":"Synthetic first site","observer":{"latitudeDeg":0,"longitudeDeg":0,"elevationMeters":0},"timeZone":"UTC"}],"activePlaceId":"site-00000000-0000-4000-8000-000000000001"},"sha256":"d9822d74fa0235d3b40bffc58878cc56a02b25980e0a70638a78b1b8ac1766cf"}\n';
const original = () => Buffer.from(fixture);
function changedState(change: (state: PlacesState) => void): Buffer {
  const document: { schemaVersion: number; state: PlacesState; sha256: string } = JSON.parse(fixture);
  change(document.state);
  document.sha256 = createHash("sha256").update(JSON.stringify(document.state)).digest("hex");
  return Buffer.from(JSON.stringify(document) + "\n");
}

it("plans an exact owned copy of the v1 document without changing revision, IDs, order or active selection", () => {
  const source = original(), plan = planObservingMigration(source, null);
  expect(plan.kind).toBe("copy");
  if (plan.kind !== "copy") throw new Error("Expected a copy plan.");
  expect(source).toEqual(original()); expect(plan.bytes).toEqual(source); expect(plan.bytes).not.toBe(source);
  const state = JSON.parse(plan.bytes.toString("utf8")).state as PlacesState;
  expect(state.revision).toBe(7);
  expect(state.places.map(place => place.id)).toEqual([
    "site-00000000-0000-4000-8000-000000000002", "site-00000000-0000-4000-8000-000000000001",
  ]);
  expect(state.activePlaceId).toBe("site-00000000-0000-4000-8000-000000000001");
});

it("is idempotent when a completed copy is observed again after a lost acknowledgement", () => {
  const source = original(), first = planObservingMigration(source, null);
  if (first.kind !== "copy") throw new Error("Expected a copy plan.");
  const committedDestination = Buffer.from(first.bytes);
  expect(planObservingMigration(source, committedDestination)).toEqual({ kind: "already-present" });
  expect(source).toEqual(original()); expect(committedDestination).toEqual(original());
});

it("blocks different existing destination bytes without ranking revisions or merging equivalent JSON", () => {
  for (const destination of [changedState(state => { state.revision = 6; }), changedState(state => { state.revision = 8; }), Buffer.from(fixture + " ")]) {
    const before = Buffer.from(destination), source = original();
    expect(planObservingMigration(source, destination)).toEqual({ kind: "blocked", reason: "conflicting-destination" });
    expect(source).toEqual(original()); expect(destination).toEqual(before);
  }
});

const corruptDocuments: readonly (readonly [string, Buffer])[] = [
  ["malformed JSON", Buffer.from("{")],
  ["empty bytes", Buffer.alloc(0)],
  ["unknown version", Buffer.from(fixture.replace('"schemaVersion":1', '"schemaVersion":2'))],
  ["extra envelope field", Buffer.from(fixture.replace('"schemaVersion":1', '"extra":true,"schemaVersion":1'))],
  ["wrong checksum", Buffer.from(fixture.replace("d9822d74fa0235d3b40bffc58878cc56a02b25980e0a70638a78b1b8ac1766cf", "0".repeat(64)))],
  ["invalid state with a correct checksum", changedState(state => { state.activePlaceId = "site-00000000-0000-4000-8000-000000000003"; })],
  ["oversized document", Buffer.concat([original(), Buffer.alloc(32_769 - Buffer.byteLength(fixture), 32)])],
];
it.each(corruptDocuments)("treats %s as corrupt on either side, including identical corrupt bytes and an absent source", (_label, corrupt) => {
  expect(planObservingMigration(corrupt, null)).toEqual({ kind: "blocked", reason: "invalid-source" });
  expect(planObservingMigration(original(), corrupt)).toEqual({ kind: "blocked", reason: "invalid-destination" });
  expect(planObservingMigration(null, corrupt)).toEqual({ kind: "blocked", reason: "invalid-destination" });
  expect(planObservingMigration(corrupt, Buffer.from(corrupt))).toEqual({ kind: "blocked", reason: "invalid-source" });
});

it("distinguishes a missing legacy document from corruption and preserves any valid destination", () => {
  expect(planObservingMigration(null, null)).toEqual({ kind: "no-source" });
  const destination = original();
  expect(planObservingMigration(null, destination)).toEqual({ kind: "no-source" });
  expect(destination).toEqual(original());
});

it("preserves reader-accepted whitespace exactly and admits the 32768-byte boundary", () => {
  const source = Buffer.concat([original(), Buffer.alloc(32_768 - Buffer.byteLength(fixture), 32)]);
  const before = Buffer.from(source);
  const plan = planObservingMigration(source, null);
  if (plan.kind !== "copy") throw new Error("Expected a copy plan.");
  expect(plan.bytes).toHaveLength(32_768); expect(plan.bytes).toEqual(before); expect(source).toEqual(before);
});

it("owns the returned snapshot independently of a caller's byte view and later mutations", () => {
  const backing = Buffer.concat([Buffer.from([255]), original(), Buffer.from([255])]);
  const source = new Uint8Array(backing.buffer, backing.byteOffset + 1, Buffer.byteLength(fixture));
  const plan = planObservingMigration(source, null);
  if (plan.kind !== "copy") throw new Error("Expected a copy plan.");
  source.fill(0); expect(plan.bytes).toEqual(original());
  plan.bytes.fill(255); expect(source.every(value => value === 0)).toBe(true);
  expect(backing[0]).toBe(255); expect(backing.at(-1)).toBe(255);
});
