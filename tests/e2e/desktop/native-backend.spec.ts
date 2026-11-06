import { expect, test, type ElectronApplication } from "@playwright/test";
import { randomBytes, createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { isPlacesState } from "@tahtiapuri/validation/observing";
import type { PlacesState } from "@tahtiapuri/domain";
import { launch } from "../support/electron.js";
import { addPlace } from "../support/observing.js";

const runtimeRoot = process.env.TAHTIAPURI_TEST_NATIVE_BACKEND_ROOT;
test.skip(!runtimeRoot, "A separately prepared and admitted native backend runtime is required.");
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function storage(raw: Buffer): PlacesState {
  const value = JSON.parse(raw.toString("utf8")) as { schemaVersion: number; state: PlacesState; sha256: string };
  expect(value.schemaVersion).toBe(1); expect(isPlacesState(value.state)).toBe(true);
  expect(value.sha256).toBe(sha(JSON.stringify(value.state))); return value.state;
}
async function cleanJournal(data: string, digest: string) {
  const raw = await readFile(join(data, "backend-state/control/recovery.journal"));
  expect(raw.length).toBeLessThanOrEqual(4096);
  expect([...raw].every(byte => byte === 10 || byte >= 32 && byte <= 126)).toBe(true);
  const text = raw.toString("ascii"); expect(text.endsWith("\n")).toBe(true);
  const lines = text.slice(0, -1).split("\n"); expect(lines).toHaveLength(18);
  expect(lines[0]).toBe("TAHTIAPURI_BACKEND_JOURNAL_V2"); expect(lines[1]).toBe(digest);
  expect(lines[17]).toMatch(/^[a-f0-9]{64}$/); expect(lines[17]).toBe(sha(raw.subarray(0, raw.length - 65)));
  const ownerRaw = await readFile(join(data, "backend-state/control/owner.marker"));
  expect(ownerRaw.length).toBeLessThanOrEqual(1024);
  expect([...ownerRaw].every(byte => byte === 10 || byte >= 32 && byte <= 126)).toBe(true);
  expect(ownerRaw.at(-1)).toBe(10);
  const owner = ownerRaw.toString("ascii").slice(0, -1).split("\n"); expect(owner).toHaveLength(4);
  expect(owner[0]).toBe("TAHTIAPURI_BACKEND_STATE_V1"); expect(owner[1]).toMatch(/^S-\d+(?:-\d+)+$/);
  expect(owner[2]).toMatch(/^[a-f0-9]{24}$/); expect(owner[3]).toMatch(/^[a-f0-9]{24}$/);
  expect(lines.slice(2, 5)).toEqual(owner.slice(1));
  expect(lines[5]).toBe("OWNER_SYSTEM_PROTECTED_MEDIUM_V1"); expect(lines[6]).toBe("CREATION_JOB_LIST_GLOBAL_V1");
  expect(lines[7]).toBe("CLEAN"); expect(lines[12]).toBe("NONE"); expect(lines[14]).toBe("NONE");
  for (const index of [8, 9, 10, 11, 13, 15, 16]) expect(lines[index]).toBe("-");
}

test("native backend migrates the acknowledged legacy place and preserves later edits across restart", async ({}, info) => {
  test.setTimeout(120_000);
  // Keep staged CreateProcess paths short. All fresh synthetic data is retained.
  let parent = process.cwd();
  for (const component of [".artifacts", "tests", "native-backend"]) {
    const before = await lstat(parent); expect(before.isDirectory() && !before.isSymbolicLink()).toBe(true);
    expect(relative(parent, await realpath(parent))).toBe("");
    parent = join(parent, component);
    try { await mkdir(parent); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const after = await lstat(parent); expect(after.isDirectory() && !after.isSymbolicLink()).toBe(true);
    expect(relative(parent, await realpath(parent))).toBe("");
  }
  const data = join(parent, "run-" + randomBytes(16).toString("hex")); await mkdir(data);
  await info.attach("retained-synthetic-case", { body: JSON.stringify({ data }), contentType: "application/json" });
  let application: ElectronApplication | undefined;
  const close = async () => {
    const current = application; if (!current) return;
    const process = current.process(); await current.close();
    expect(process.exitCode).toBe(0); expect(process.signalCode).toBeNull(); application = undefined;
  };
  const source = join(data, "observing/places.json"), destination = join(data, "backend-state/data/observing/places.json");
  const marker = join(data, "backend-state/control/observing-migration.marker");
  try {
    application = await launch(data);
    await addPlace(await application.firstWindow(), "Synthetic legacy place", "0", "0", "UTC");
    await close();
    const legacy = await readFile(source), oldState = storage(legacy);
    expect(oldState.places).toHaveLength(1); expect(oldState.activePlaceId).toBe(oldState.places[0]!.id);
    const metadata = JSON.parse(await readFile(join(runtimeRoot!, "runtime-descriptor.json"), "utf8")) as { package: { digest: string } };

    application = await launch(data, "native-backend"); let page = await application.firstWindow();
    await expect(page.getByRole("status", { name: "Yhteyden tila", exact: true })).toHaveText("Yhteys toimii");
    await expect(page.getByTestId("active-observation")).toContainText("Synthetic legacy place");
    expect(await readFile(destination)).toEqual(legacy); expect(await readFile(source)).toEqual(legacy);
    const originalMarker = await readFile(marker);
    await page.getByRole("button", { name: "Muokkaa paikkaa", exact: true }).click();
    await page.getByLabel("Paikan nimi", { exact: true }).fill("Synthetic native edit");
    await page.getByRole("button", { name: "Tallenna ja käytä paikkaa", exact: true }).click();
    await expect(page.getByTestId("active-observation")).toContainText("Synthetic native edit");
    const saved = await readFile(destination), newState = storage(saved);
    expect(newState.revision).toBeGreaterThan(oldState.revision); expect(newState.activePlaceId).toBe(oldState.activePlaceId);
    expect(newState.places.find(place => place.id === oldState.activePlaceId)?.name).toBe("Synthetic native edit");
    expect(await readFile(source)).toEqual(legacy); expect(await readFile(marker)).toEqual(originalMarker);
    await close(); await cleanJournal(data, metadata.package.digest);
    expect(await readFile(destination)).toEqual(saved);

    application = await launch(data, "native-backend"); page = await application.firstWindow();
    await expect(page.getByTestId("active-observation")).toContainText("Synthetic native edit");
    expect(await readFile(destination)).toEqual(saved); expect(await readFile(source)).toEqual(legacy);
    expect(await readFile(marker)).toEqual(originalMarker);
    await close(); await cleanJournal(data, metadata.package.digest);
    expect(await readFile(destination)).toEqual(saved); expect(await readFile(source)).toEqual(legacy);
  } finally { if (application) await application.close().catch(() => {}); }
});
