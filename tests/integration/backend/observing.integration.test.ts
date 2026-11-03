import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile, rm, link, symlink, readdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { createBackend } from "../../../apps/backend/src/composition/create-backend.js";
import { PlacesService } from "../../../apps/backend/src/modules/observing/application/places-service.js";
import { JsonPlacesRepository } from "../../../apps/backend/src/modules/observing/adapters/json-places-repository.js";
import { isObservingResult, isObservingInput, type ObservingResult } from "@tahtiapuri/validation/observing";
import type { PlacesState } from "@tahtiapuri/domain";
const place = { name: "Synteettinen A", observer: { latitudeDeg: 60, longitudeDeg: 25, elevationMeters: 0 }, timeZone: "Europe/Helsinki" };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  await mkdir(".artifacts/tests/t08", { recursive: true });
  const root = await mkdtemp(resolve(".artifacts/tests/t08/places-")); roots.push(root);
  const repository = new JsonPlacesRepository(root), service = new PlacesService(repository, () => 1000);
  return { root, repository, service, path: join(root, "observing/places.json") };
}
const good = (result: ObservingResult) => { expect(result.ok).toBe(true); if (!result.ok) throw new Error("Missing places state"); return result.state; };
it("persists named places, edits and the explicitly active id across a fresh service", async () => {
  const s = await setup(); expect(good(await s.service.execute("observing.read", undefined, 2000))).toEqual({ revision: 0, places: [], activePlaceId: null });
  const first = good(await s.service.execute("observing.save", { expectedRevision: 0, id: null, place: { ...place, name: " Synteettinen A " } }, 2000));
  expect(first.places[0]!.name).toBe("Synteettinen A"); expect(first.activePlaceId).toBe(first.places[0]!.id);
  const second = good(await s.service.execute("observing.save", { expectedRevision: first.revision, id: null, place: { ...place, name: "Synteettinen B", observer: { latitudeDeg: 70, longitudeDeg: 20, elevationMeters: 0 } } }, 2000));
  const selected = good(await s.service.execute("observing.activate", { expectedRevision: second.revision, id: first.activePlaceId }, 2000));
  const next = new PlacesService(new JsonPlacesRepository(s.root), () => 1000);
  expect(good(await next.execute("observing.read", undefined, 2000))).toEqual(selected);
  expect(isObservingResult({ ok: true, state: selected })).toBe(true);
  const removed = good(await next.execute("observing.remove", { expectedRevision: selected.revision, id: selected.activePlaceId }, 2000));
  expect(removed.places).toHaveLength(1); expect(removed.activePlaceId).toBeNull();
  expect(good(await new PlacesService(new JsonPlacesRepository(s.root), () => 1000).execute("observing.read", undefined, 2000))).toEqual(removed);
});
it.each([
  { ...place, observer: { ...place.observer, latitudeDeg: 91 } }, { ...place, observer: { ...place.observer, longitudeDeg: Infinity } },
  { ...place, name: "   " }, { ...place, timeZone: "../private" }, { ...place, observer: { ...place.observer, file: "outside" } }, { ...place, url: "https://invalid.test" },
])("rejects invalid settings without changing the stored bytes: %j", async invalid => {
  const s = await setup(); const state = good(await s.service.execute("observing.save", { expectedRevision: 0, id: null, place }, 2000));
  const before = await readFile(s.path);
  expect(await s.service.execute("observing.save", { expectedRevision: state.revision, id: state.activePlaceId, place: invalid }, 2000)).toEqual({ ok: false, code: "INVALID_INPUT" });
  expect(await readFile(s.path)).toEqual(before);
});
it("rejects stale revisions and duplicate names while retaining the last acknowledged state", async () => {
  const s = await setup(), first = good(await s.service.execute("observing.save", { expectedRevision: 0, id: null, place }, 2000));
  expect(await s.service.execute("observing.remove", { expectedRevision: 0, id: first.activePlaceId }, 2000)).toEqual({ ok: false, code: "CONFLICT" });
  expect(await s.service.execute("observing.save", { expectedRevision: 1, id: null, place: { ...place, name: place.name.toLowerCase() } }, 2000)).toEqual({ ok: false, code: "DUPLICATE_NAME" });
  expect((await s.repository.load()).state).toEqual(first);
});
it.each(["{broken", "", JSON.stringify({ schemaVersion: 999, state: {}, sha256: "changed" }), "x".repeat(32769)])("does not initialize unreadable or unsupported storage as empty", async raw => {
  const s = await setup(); await s.repository.load(); await writeFile(s.path, raw);
  expect(await s.service.execute("observing.read", undefined, 2000)).toEqual({ ok: false, code: "READ_FAILED" });
  expect(await s.service.execute("observing.save", { expectedRevision: 0, id: null, place }, 2000)).toEqual({ ok: false, code: "READ_FAILED" });
  expect(await readFile(s.path, "utf8")).toBe(raw);
});
it("keeps the old file when atomic replacement fails and does not report a new active place", async () => {
  const s = await setup(), first = good(await s.service.execute("observing.save", { expectedRevision: 0, id: null, place }, 2000));
  const bytes = await readFile(s.path);
  const failing = new PlacesService(new JsonPlacesRepository(s.root, async () => { throw new Error("synthetic replacement failure"); }), () => 1000);
  expect(await failing.execute("observing.save", { expectedRevision: 1, id: first.activePlaceId, place: { ...place, name: "Synteettinen muutos" } }, 2000)).toEqual({ ok: false, code: "SAVE_FAILED" });
  expect(await readFile(s.path)).toEqual(bytes); expect((await s.repository.load()).state).toEqual(first);
  expect((await readdir(join(s.root, "observing"))).filter(f => f.endsWith(".tmp"))).toEqual([]);
});
it("rejects a changed file token and a revoked commit right", async () => {
  const s = await setup(), old = await s.repository.load();
  const state = good(await s.service.execute("observing.save", { expectedRevision: 0, id: null, place }, 2000));
  await expect(s.repository.save({ ...state, revision: 2 }, old.token, () => true)).rejects.toThrow("CONFLICT");
  const loaded = await s.repository.load();
  await expect(s.repository.save({ ...state, revision: 2 }, loaded.token, () => false)).rejects.toThrow("UNAVAILABLE");
  expect((await s.repository.load()).state).toEqual(state);
});
it("refuses a linked data directory and hard-linked profile file", async () => {
  const s = await setup(); const target = join(s.root, "outside"); await mkdir(target);
  await symlink(target, join(s.root, "observing"), process.platform === "win32" ? "junction" : "dir");
  await expect(s.repository.load()).rejects.toThrow("READ_FAILED");
  const other = await setup(); good(await other.service.execute("observing.save", { expectedRevision: 0, id: null, place }, 2000));
  await link(other.path, join(other.root, "linked-copy.json"));
  await expect(other.repository.load()).rejects.toThrow("READ_FAILED");
});
for (const point of ["before", "after"] as const) {
  it("survives process interruption " + point + " the atomic commit point", async () => {
    const s = await setup(), first = good(await s.service.execute("observing.save", { expectedRevision: 0, id: null, place }, 2000));
    const child = fork(resolve("tests/support/observing-write-crash.mjs"), [s.root, point], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Crash fixture did not reach commit point")), 5000);
        child.once("message", message => { clearTimeout(timer); if (message === point) resolve(); else reject(new Error("Wrong fixture stage")); });
        child.once("error", error => { clearTimeout(timer); reject(error); });
      });
      child.kill(); await exited;
      const restored = (await new JsonPlacesRepository(s.root).load()).state;
      if (point === "before") expect(restored).toEqual(first);
      else { expect(restored.revision).toBe(first.revision + 1); expect(restored.places[0]!.name).toBe("Synteettinen keskeytys"); }
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; }
  });
}
it("bounds concurrent IPC work and drains writes on close without returning a late result", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const state: PlacesState = { revision: 0, places: [], activePlaceId: null };
  let writes = 0;
  const service = new PlacesService({ load: async () => { await held; return { state, token: null }; }, save: async (_state, _token, canCommit) => { if (canCommit()) writes++; } }, () => 1000);
  const messages: unknown[] = []; let stopped = false;
  const endpoint = createBackend({ observing: service, send: m => messages.push(m), stop: () => { stopped = true; }, now: () => 1000 });
  const session = "a".repeat(64);
  endpoint.receive({ type: "initialize", protocol: 1, session });
  let serial = 0;
  const request = (operation: string, input?: unknown) => ({ type: "request", protocol: 1, session, id: "00000000-0000-4000-8000-" + String(++serial).padStart(12, "0"), expiresAtUnixMs: 2000, operation, ...(input !== undefined ? { input } : {}) });
  endpoint.receive(request("observing.save", { expectedRevision: 0, id: null, place }));
  endpoint.receive(request("observing.read"));
  await Promise.resolve(); expect(messages.at(-1)).toMatchObject({ result: { ok: false, code: "BUSY" } });
  expect(endpoint.receive({ ...request("observing.read"), role: "assistant" })).toBe(false);
  endpoint.receive(request("runtime.shutdown")); expect(stopped).toBe(false); const count = messages.length;
  release(); await new Promise<void>(resolve => setImmediate(resolve));
  expect(writes).toBe(0); expect(stopped).toBe(true); expect(messages).toHaveLength(count);
});
it("validates result identity, references and exact public keys", () => {
  expect(isObservingInput("observing.read", {})).toBe(false);
  expect(isObservingInput("observing.remove", { expectedRevision: 0, id: "../../outside" })).toBe(false);
  expect(isObservingResult({ ok: true, state: { revision: 1, places: [], activePlaceId: "site-00000000-0000-4000-8000-000000000001" } })).toBe(false);
  expect(isObservingResult({ ok: false, code: "READ_FAILED", path: "private" })).toBe(false);
});

it("detects a valid-shaped checksum mismatch and preserves the original unreadable bytes", async () => {
  const s = await setup(); good(await s.service.execute("observing.save", { expectedRevision: 0, id: null, place }, 2000));
  const data = JSON.parse(await readFile(s.path, "utf8")); data.state.places[0].name = "Synteettinen muuttunut tieto";
  const changed = JSON.stringify(data); await writeFile(s.path, changed);
  expect(await s.service.execute("observing.read", undefined, 2000)).toEqual({ ok: false, code: "READ_FAILED" });
  expect(await s.service.execute("observing.save", { expectedRevision: 1, id: null, place }, 2000)).toEqual({ ok: false, code: "READ_FAILED" });
  expect(await readFile(s.path, "utf8")).toBe(changed);
});
it("detects an existing file changed by another writer before replacement", async () => {
  const s = await setup(), first = good(await s.service.execute("observing.save", { expectedRevision: 0, id: null, place }, 2000));
  const loaded = await s.repository.load();
  const other = new PlacesService(new JsonPlacesRepository(s.root), () => 1000);
  const updated = good(await other.execute("observing.save", { expectedRevision: 1, id: first.activePlaceId, place: { ...place, name: "Synteettinen ulkoinen muutos" } }, 2000));
  await expect(s.repository.save({ ...first, revision: 2 }, loaded.token, () => true)).rejects.toThrow("CONFLICT");
  expect((await s.repository.load()).state).toEqual(updated);
});
it("does not commit a write whose deadline passed during loading", async () => {
  const s = await setup(); let now = 1000;
  const service = new PlacesService({ load: async () => { const loaded = await s.repository.load(); now = 2001; return loaded; }, save: (state, token, canCommit) => s.repository.save(state, token, canCommit) }, () => now);
  expect(await service.execute("observing.save", { expectedRevision: 0, id: null, place }, 2000)).toEqual({ ok: false, code: "UNAVAILABLE" });
  expect((await s.repository.load()).state.places).toEqual([]);
});

it("enforces the bounded profile count without writing a seventeenth place", async () => {
  const places = Array.from({ length: 16 }, (_, i) => ({ ...place, id: "site-" + randomUUID(), name: "Synteettinen " + i }));
  const state: PlacesState = { revision: 1, places, activePlaceId: places[0]!.id }; let writes = 0;
  const service = new PlacesService({ load: async () => ({ state, token: "synthetic" }), save: async () => { writes++; } }, () => 1000);
  expect(await service.execute("observing.save", { expectedRevision: 1, id: null, place }, 2000)).toEqual({ ok: false, code: "LIMIT_REACHED" });
  expect(writes).toBe(0);
  expect(isObservingResult({ ok: true, state: { ...state, places: [...places, { ...place, id: "site-" + randomUUID() }] } })).toBe(false);
});

it.each(["writeFile", "sync"] as const)("preserves the acknowledged file after a staged %s failure", async operation => {
  const s = await setup(), first = good(await s.service.execute("observing.save", { expectedRevision: 0, id: null, place }, 2000));
  const before = await readFile(s.path), probe = await open(join(s.root, "probe"), "w");
  const prototype = Object.getPrototypeOf(probe); await probe.close();
  const failure = vi.spyOn(prototype, operation).mockRejectedValueOnce(new Error("synthetic staged failure"));
  try {
    expect(await s.service.execute("observing.save", { expectedRevision: 1, id: first.activePlaceId, place: { ...place, name: "Synteettinen vaihevirhe" } }, 2000)).toEqual({ ok: false, code: "SAVE_FAILED" });
    expect(await readFile(s.path)).toEqual(before);
    expect((await readdir(join(s.root, "observing"))).filter(f => f.endsWith(".tmp"))).toEqual([]);
  } finally { failure.mockRestore(); }
});
