import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { readFile, writeFile, access } from "node:fs/promises";
import { launch, backendPid, expectGone } from "../support/electron.js";
import { addPlace, setSyntheticTime } from "../support/observing.js";

test("settings CRUD persists active place and reopens its current-time map; deletion requires a fresh choice", async ({}, info) => {
  const data = info.outputPath("data"); let app = await launch(data);
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole("status", { name: "Kartan tila", exact: true })).toContainText("Valitse havaintopaikka");
    await addPlace(page, "Synteettinen A"); await setSyntheticTime(page);
    await expect(page.getByTestId("active-observation")).toContainText("60° / 25°");
    await addPlace(page, "Synteettinen B", "70", "20");
    await expect(page.getByTestId("active-observation")).toContainText("70° / 20°");
    const choice = page.getByRole("combobox", { name: "Tallennettu havaintopaikka", exact: true });
    await choice.selectOption({ label: "Synteettinen A" });
    await expect(page.getByTestId("active-observation")).toContainText("Synteettinen A");
    await page.getByRole("button", { name: "Muokkaa paikkaa", exact: true }).click();
    await page.getByLabel("Paikan nimi", { exact: true }).fill("Synteettinen A päivitetty");
    await page.getByLabel("Leveysaste °", { exact: true }).fill("0"); await page.getByLabel("Pituusaste °", { exact: true }).fill("0");
    await page.getByLabel("Aikavyöhyke", { exact: true }).fill("UTC");
    await page.getByRole("button", { name: "Tallenna ja käytä paikkaa", exact: true }).click();
    await expect(page.getByTestId("active-observation")).toContainText("2024-03-31 00:30:00 · UTC");
    const pid = await backendPid(app); await app.close(); await expectGone(pid);
    app = await launch(data); page = await app.firstWindow();
    await expect(page.getByTestId("active-observation")).toContainText("Synteettinen A päivitetty");
    await expect(page.getByTestId("active-observation")).toContainText("0° / 0°");
    await page.clock.setFixedTime(new Date("2024-06-21T18:00:00Z")); await page.reload();
    await expect(page.getByTestId("active-observation")).toContainText("2024-06-21 18:00:00 · UTC");
    await page.getByRole("button", { name: "Poista paikka", exact: true }).click();
    await page.getByRole("button", { name: "Peru poisto", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Tallennettu havaintopaikka", exact: true })).toHaveValue(/site-/);
    await page.getByRole("button", { name: "Poista paikka", exact: true }).click(); await page.getByRole("button", { name: "Vahvista poisto", exact: true }).click();
    await expect(page.getByRole("status", { name: "Kartan tila", exact: true })).toContainText("Valitse havaintopaikka");
    await app.close(); app = await launch(data); page = await app.firstWindow();
    await expect(page.getByRole("combobox", { name: "Tallennettu havaintopaikka", exact: true })).toHaveValue("");
    await page.getByRole("combobox", { name: "Tallennettu havaintopaikka", exact: true }).selectOption({ label: "Synteettinen B" });
    await expect(page.getByTestId("active-observation")).toContainText("70° / 20°");
    await page.setViewportSize({ width: 1100, height: 850 }); await page.screenshot({ path: info.outputPath("places.png"), fullPage: true });
  } finally { await app.close(); }
});

test("corrupt startup storage is preserved and explicit reload can recover a repaired synthetic file", async ({}, info) => {
  const data = info.outputPath("data"); let app = await launch(data);
  try {
    let page = await app.firstWindow(); await addPlace(page); await app.close();
    const file = join(data, "observing/places.json"), good = await readFile(file); const bad = "{synthetic interrupted content";
    await writeFile(file, bad); app = await launch(data); page = await app.firstWindow();
    await expect(page.getByRole("alert")).toContainText("Tiedostoa ei korvata tyhjällä");
    await expect(page.getByRole("button", { name: "Lisää paikka", exact: true })).toBeDisabled();
    expect(await readFile(file, "utf8")).toBe(bad);
    await writeFile(file, good); await page.getByRole("button", { name: "Lataa paikat uudelleen", exact: true }).click();
    await expect(page.getByTestId("active-observation")).toContainText("Synteettinen A");
  } finally { await app.close(); }
});

test("failed save retains old bytes and blocks further mutations until a successful reload", async ({}, info) => {
  const data = info.outputPath("data"); let app = await launch(data);
  try {
    let page = await app.firstWindow(); await addPlace(page); await app.close();
    const file = join(data, "observing/places.json"), before = await readFile(file);
    app = await launch(data, "observing-save-fail"); page = await app.firstWindow();
    await expect(page.getByTestId("active-observation")).toContainText("Synteettinen A");
    await page.getByRole("button", { name: "Muokkaa paikkaa", exact: true }).click();
    await page.getByLabel("Paikan nimi", { exact: true }).fill("Synteettinen tallennusvirhe");
    await page.getByRole("button", { name: "Tallenna ja käytä paikkaa", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("tallennus ei varmistunut");
    await expect(page.getByRole("button", { name: "Tallenna ja käytä paikkaa", exact: true })).toBeDisabled();
    expect(await readFile(file)).toEqual(before);
    await page.getByRole("button", { name: "Lataa paikat uudelleen", exact: true }).click();
    await expect(page.getByTestId("active-observation")).toContainText("Synteettinen A");
    await expect(page.getByLabel("Paikan nimi", { exact: true })).toHaveValue("Synteettinen tallennusvirhe");
  } finally { await app.close(); }
});

test("a place change during a held later-time calculation keeps the requested time and rejects the old place result", async ({}, info) => {
  const data = info.outputPath("data"); const app = await launch(data, "observing-sky-hold");
  try {
    const page = await app.firstWindow(); await addPlace(page, "Synteettinen A"); await addPlace(page, "Synteettinen B", "70", "20");
    await page.getByRole("combobox", { name: "Tallennettu havaintopaikka", exact: true }).selectOption({ label: "Synteettinen A" });
    await expect(page.getByRole("status", { name: "Paikkojen tila", exact: true })).toHaveText("Aktiivinen paikka: Synteettinen A");
    await setSyntheticTime(page); await expect(page.getByTestId("active-observation")).toContainText("02:30:00");
    await page.getByRole("button", { name: "+1 h", exact: true }).click();
    await expect.poll(async () => { try { await access(join(data, "sky-held")); return true; } catch { return false; } }).toBe(true);
    await page.getByRole("combobox", { name: "Tallennettu havaintopaikka", exact: true }).selectOption({ label: "Synteettinen B" });
    await expect(page.getByRole("status", { name: "Paikkojen tila", exact: true })).toContainText("Synteettinen B");
    await writeFile(join(data, "release-sky"), "synthetic release");
    await expect(page.getByTestId("active-observation")).toContainText("Synteettinen B");
    await expect(page.getByTestId("active-observation")).toContainText("2024-03-31 04:30:00");
    await expect(page.getByTestId("active-observation")).toContainText("70° / 20°");
  } finally { await app.close(); }
});

test("places IPC denies extra keys, URL/path inputs and a foreign same-origin window", async ({}, info) => {
  const app = await launch(info.outputPath("data"), "probe");
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("status", { name: "Paikkojen tila", exact: true })).toContainText("Valitse havaintopaikka");
    const denied = await page.evaluate(async () => {
      const probe = (window as unknown as { probe: { placesRead(...args: unknown[]): Promise<unknown>; placesSave(...args: unknown[]): Promise<unknown>; placesRemove(...args: unknown[]): Promise<unknown> } }).probe;
      const place = { name: "Synteettinen A", observer: { latitudeDeg: 60, longitudeDeg: 25, elevationMeters: 0 }, timeZone: "Europe/Helsinki" };
      const results = [];
      results.push(await probe.placesRead({ path: "outside" }).then(() => "allowed", () => "denied"));
      results.push(await probe.placesSave({ expectedRevision: 0, id: null, place, path: "outside" }).then(() => "allowed", () => "denied"));
      results.push(await probe.placesSave({ expectedRevision: 0, id: null, place: { ...place, observer: { ...place.observer, latitudeDeg: 91 } } }).then(() => "allowed", () => "denied"));
      results.push(await probe.placesRemove({ expectedRevision: 0, id: "https://invalid.test" }).then(() => "allowed", () => "denied"));
      return results;
    });
    expect(denied).toEqual(Array(4).fill("denied"));
    const foreign = await app.evaluate(async ({ BrowserWindow }, preload) => {
      const owner = BrowserWindow.getAllWindows()[0]!;
      const other = new BrowserWindow({ show: false, webPreferences: { session: owner.webContents.session, preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      try { await other.loadURL("tahtiapuri://app/index.html"); return await other.webContents.executeJavaScript("window.probe.placesRead().then(() => 'allowed', () => 'denied')"); }
      finally { other.destroy(); }
    }, join(process.cwd(), ".artifacts/tests/e2e-build/probe-preload.cjs"));
    expect(foreign).toBe("denied");
  } finally { await app.close(); }
});
