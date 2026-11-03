import { beforeAll, expect, it } from "vitest";
import { createSky } from "../../../apps/backend/src/composition/create-sky.js";
import { createBackend } from "../../../apps/backend/src/composition/create-backend.js";
import { SkyQueries } from "../../../apps/backend/src/modules/sky/application/sky-queries.js";
import { isSkyResult, isSkySelectionResult, isSkySnapshot, isObservationRequest } from "@tahtiapuri/validation/sky";
import { isResponse, type Response } from "@tahtiapuri/validation/backend";
const observation = { atUtc: "2024-03-31T00:30:00.000Z", timeZone: "Europe/Helsinki", observer: { latitudeDeg: 60, longitudeDeg: 25, elevationMeters: 0 } };
const session = "a".repeat(64);
let queries: SkyQueries;
beforeAll(async () => { queries = new SkyQueries(Promise.resolve(await createSky("resources/catalogs"))); });
function setup(sky = queries) {
  const messages: unknown[] = []; let serial = 0;
  const endpoint = createBackend({ sky, send: m => messages.push(m), stop: () => {}, now: () => 1000 });
  endpoint.receive({ type: "initialize", protocol: 1, session });
  const request = (operation: string, input?: unknown) => ({ type: "request", protocol: 1, session, id: "00000000-0000-4000-8000-" + String(++serial).padStart(12, "0"), expiresAtUnixMs: 2000, operation, ...(input !== undefined ? { input } : {}) });
  return { endpoint, messages, request };
}
const settle = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
it("delivers a bounded, validated local snapshot and resolves the selected id in the same context", async () => {
  const s = setup(); expect(s.endpoint.receive(s.request("sky.snapshot", observation))).toBe(true); await settle();
  const reply = s.messages.at(-1) as Response;
  expect(isResponse(reply, session)).toBe(true); expect(isSkyResult(reply.result)).toBe(true);
  if (!isSkyResult(reply.result) || !reply.result.ok) throw new Error("Snapshot missing");
  const snapshot = reply.result.snapshot; expect(snapshot.objects).toHaveLength(5079);
  expect(JSON.stringify(snapshot).length).toBeLessThan(4_000_000);
  s.endpoint.receive(s.request("sky.select", { observation, objectId: "Jupiter" })); await settle();
  const result = (s.messages.at(-1) as Response).result;
  expect(isSkySelectionResult(result)).toBe(true);
  if (!isSkySelectionResult(result) || !result.ok) throw new Error("Selection missing");
  expect(result.selection.context).toEqual(snapshot.context);
  expect(result.selection.object).toEqual(snapshot.objects.find(o => o.id === "Jupiter"));
  const changed = await queries.snapshot({ ...observation, atUtc: "2024-03-31T01:30:00.000Z", observer: { latitudeDeg: 0, longitudeDeg: 0, elevationMeters: 0 } });
  expect(changed.ok).toBe(true);
  if (changed.ok) expect(changed.snapshot.objects.find(o => o.id === "Jupiter")!.horizontal).not.toEqual(result.selection.object.horizontal);
});
it.each([
  { ...observation, url: "https://invalid.test" }, { ...observation, path: "outside" },
  { ...observation, observer: { ...observation.observer, role: "main" } }, { ...observation, observer: { ...observation.observer, latitudeDeg: Infinity } },
  { ...observation, timeZone: "not/a/zone" }, { ...observation, atUtc: "2024-02-30T00:00:00Z" },
])("rejects malformed context before dispatch: %j", input => {
  const s = setup(); expect(isObservationRequest(input)).toBe(false);
  expect(s.endpoint.receive(s.request("sky.snapshot", input))).toBe(false); expect(s.messages).toHaveLength(1);
});
it("rejects unknown catalogue ids and does not leak catalogue errors", async () => {
  expect(await queries.select({ observation, objectId: "hyg-999999" })).toEqual({ ok: false, code: "INVALID_INPUT" });
  const missing = new SkyQueries(Promise.reject(new Error("private source path")));
  expect(await missing.snapshot(observation)).toEqual({ ok: false, code: "CATALOG_UNAVAILABLE" });
});
it("bounds concurrent sky requests, allows heartbeat and discards late work after shutdown", async () => {
  let resolveService!: (value: never) => void;
  const delayed = new SkyQueries(new Promise(resolve => { resolveService = resolve; }));
  const s = setup(delayed);
  s.endpoint.receive(s.request("sky.snapshot", observation));
  s.endpoint.receive(s.request("sky.snapshot", observation));
  expect((s.messages.at(-1) as Response).result).toEqual({ ok: false, code: "BUSY" });
  s.endpoint.receive(s.request("runtime.ping")); expect((s.messages.at(-1) as Response).result).toBeNull();
  s.endpoint.receive(s.request("runtime.shutdown")); const count = s.messages.length;
  resolveService(null as never); await settle(); expect(s.messages).toHaveLength(count);
});
it("rejects wrong timestamps, duplicate ids, secret fields, invalid units and excessive result arrays", async () => {
  const result = await queries.snapshot(observation); if (!result.ok) throw new Error("Snapshot missing");
  expect(isSkySnapshot(result.snapshot)).toBe(true);
  for (const mutate of [
    (s: typeof result.snapshot) => { s.objects[0]!.atUtc = "2024-01-01T00:00:00.000Z"; },
    (s: typeof result.snapshot) => { s.objects[1]!.id = s.objects[0]!.id; },
    (s: typeof result.snapshot) => { s.objects[0]!.equatorial.raHours = 360; },
    (s: typeof result.snapshot) => { s.context.localTime = "invented"; },
    (s: typeof result.snapshot) => { (s as unknown as Record<string, unknown>).session = session; },
    (s: typeof result.snapshot) => { (s.objects as unknown[]).push(s.objects[0]); },
  ]) { const bad = structuredClone(result.snapshot); mutate(bad); expect(isSkySnapshot(bad)).toBe(false); }
});
