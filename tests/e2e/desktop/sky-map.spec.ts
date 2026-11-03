import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { backendPid, expectGone, launch } from "../support/electron.js";
const observation = { atUtc: "2024-03-31T00:30:00.000Z", timeZone: "Europe/Helsinki", observer: { latitudeDeg: 60, longitudeDeg: 25, elevationMeters: 0 } };
async function fillObservation(page: Page) {
  await page.getByLabel("Paikan nimi", { exact: true }).fill("Synteettinen koepaikka");
  await page.getByLabel("Leveysaste °", { exact: true }).fill("60");
  await page.getByLabel("Pituusaste °", { exact: true }).fill("25");
  await page.getByLabel("Paikallinen aika", { exact: true }).fill("2024-03-31T02:30");
  await page.getByLabel("Aikavyöhyke", { exact: true }).fill("Europe/Helsinki");
  await page.getByLabel("UTC-poikkeama (min)", { exact: true }).fill("120");
  await page.getByRole("button", { name: "Näytä taivas", exact: true }).click();
}
test("local sky map follows time and observer, selects an object and makes no remote requests", async ({}, info) => {
  const app = await launch(info.outputPath("data")); const pid = await backendPid(app);
  try {
    const page = await app.firstWindow();
    const requests: string[] = []; page.on("request", request => requests.push(request.url()));
    await expect(page.getByRole("status", { name: "Kartan tila", exact: true })).toContainText("Anna havaintopaikka");
    await fillObservation(page);
    await expect(page.locator('[data-map-ready="true"]')).toBeVisible();
    await expect(page.getByTestId("active-observation")).toContainText("2024-03-31 02:30:00");
    await page.getByRole("combobox", { name: "Kartan kohde", exact: true }).selectOption("Jupiter");
    const card = page.getByRole("region", { name: "Kohdetiedot", exact: true });
    await expect(card).toHaveAttribute("data-object-id", "Jupiter");
    await expect(card).toContainText("2024-03-31 02:30:00");
    const original = await card.textContent();
    await page.getByRole("button", { name: "+1 h", exact: true }).click();
    await expect(page.getByTestId("active-observation")).toContainText("2024-03-31 04:30:00");
    await expect(card).not.toHaveAttribute("data-object-id", "Jupiter");
    await page.getByRole("combobox", { name: "Kartan kohde", exact: true }).selectOption("Jupiter");
    await expect(card).toHaveAttribute("data-object-id", "Jupiter"); expect(await card.textContent()).not.toBe(original);
    await page.getByLabel("Leveysaste °", { exact: true }).fill("0");
    await expect(page.locator('[data-map-ready="true"]')).toHaveCount(0);
    await page.getByLabel("Pituusaste °", { exact: true }).fill("0");
    await page.getByRole("button", { name: "Näytä taivas", exact: true }).click();
    await expect(page.getByTestId("active-observation")).toContainText("0° / 0°");
    await page.getByRole("searchbox", { name: "Nimi tai tunniste", exact: true }).fill("Sirius");
    const option = page.getByRole("combobox", { name: "Kartan kohde", exact: true }).locator("option").filter({ hasText: "Sirius" });
    const starId = await option.getAttribute("value"); expect(starId).toMatch(/^hyg-/);
    await page.getByRole("combobox", { name: "Kartan kohde", exact: true }).selectOption(starId!);
    await expect(card).toContainText("Sirius");
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.screenshot({ path: info.outputPath("sky-map.png"), fullPage: true });
    await page.setViewportSize({ width: 680, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("sky-map-narrow.png"), fullPage: true });
    const assets = await page.locator('script[src], link[rel="stylesheet"]').evaluateAll(nodes => nodes.map(node => node.tagName === "SCRIPT" ? (node as HTMLScriptElement).src : (node as HTMLLinkElement).href));
    expect(assets.length).toBeGreaterThan(0);
    expect([...assets, ...requests].every(url => url.startsWith("tahtiapuri://app/"))).toBe(true);
  } finally { await app.close(); }
  await expectGone(pid);
});
test("canvas hit selection resolves to the backend object and chart context", async ({}, info) => {
  const app = await launch(info.outputPath("data"));
  try {
    const page = await app.firstWindow(); await fillObservation(page);
    await expect(page.locator('[data-map-ready="true"]')).toBeVisible();
    const target = await page.evaluate(async input => {
      const result = await window.tahtiapuri.sky!.snapshot(input); if (!result.ok) throw new Error("No snapshot");
      const points = result.snapshot.objects.filter(o => o.horizontal.altitudeDeg >= 0 && o.horizontal.azimuthDeg !== null).map(object => {
        const radius = (90 - object.horizontal.altitudeDeg) / 90 * 346, angle = object.horizontal.azimuthDeg! * Math.PI / 180;
        return { id: object.id, x: 400 - radius * Math.sin(angle), y: 400 - radius * Math.cos(angle), object };
      });
      const target = [...points].sort((a, b) => (a.object.magnitude.value ?? 6) - (b.object.magnitude.value ?? 6)).find(p => p.object.horizontal.altitudeDeg > 5 && p.object.horizontal.altitudeDeg < 85 && points.every(other => other.id === p.id || Math.hypot(other.x - p.x, other.y - p.y) > 8));
      if (!target) throw new Error("Missing isolated synthetic target");
      return { id: target.id, x: target.x, y: target.y };
    }, observation);
    const canvas = page.getByRole("img", { name: /^Taivaskartta:/ });
    await canvas.scrollIntoViewIfNeeded(); const box = await canvas.boundingBox(); if (!box) throw new Error("No canvas bounds");
    await canvas.click({ position: { x: target.x / 800 * box.width, y: target.y / 800 * box.height } });
    await expect(page.getByRole("region", { name: "Kohdetiedot", exact: true })).toHaveAttribute("data-object-id", target.id);
  } finally { await app.close(); }
});
test("invalid DST wall time is visible and missing catalogue leaves the UI usable", async ({}, info) => {
  const app = await launch(info.outputPath("data"), "sky-no-catalog");
  try {
    const page = await app.firstWindow(); await fillObservation(page);
    await expect(page.getByRole("alert")).toContainText("Paikallinen tähtiaineisto puuttuu");
    await expect(page.getByRole("status", { name: "Yhteyden tila", exact: true })).toHaveText("Yhteys toimii");
    await page.getByLabel("Paikallinen aika", { exact: true }).fill("2024-03-31T03:30");
    await page.getByRole("button", { name: "Näytä taivas", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Kesäajan siirtymään");
    await page.getByRole("button", { name: "Tarkista yhteys uudelleen" }).click();
    await expect(page.getByRole("status", { name: "Yhteyden tila", exact: true })).toHaveText("Yhteys toimii");
  } finally { await app.close(); }
});
test("sky IPC denies extra keys, arbitrary paths, foreign windows", async ({}, info) => {
  const app = await launch(info.outputPath("data"), "probe");
  try {
    const page = await app.firstWindow();
    const denied = await page.evaluate(async input => {
      const probe = (window as unknown as { probe: { skySnapshot(...args: unknown[]): Promise<unknown>; skySelect(...args: unknown[]): Promise<unknown> } }).probe;
      const outcomes: string[] = [];
      for (const args of [[], [input, "extra"], [{ ...input, catalogPath: "outside" }], [{ ...input, observer: { ...input.observer, url: "https://invalid.test" } }]]) {
        outcomes.push(await probe.skySnapshot(...args).then(() => "allowed", () => "denied"));
      }
      outcomes.push(await probe.skySelect({ observation: input, objectId: "../../outside" }).then(() => "allowed", () => "denied"));
      return outcomes;
    }, observation);
    expect(denied).toEqual(Array(5).fill("denied"));
    const foreign = await app.evaluate(async ({ BrowserWindow }, input) => {
      const owner = BrowserWindow.getAllWindows()[0]!;
      const other = new BrowserWindow({ show: false, webPreferences: { session: owner.webContents.session, preload: input.preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      try { await other.loadURL("tahtiapuri://app/index.html"); return await other.webContents.executeJavaScript("window.probe.skySnapshot(" + JSON.stringify(input.observation) + ").then(() => 'allowed', () => 'denied')"); }
      finally { other.destroy(); }
    }, { observation, preload: join(process.cwd(), ".artifacts/tests/e2e-build/probe-preload.cjs") });
    expect(foreign).toBe("denied");
    const concurrent = await page.evaluate(async input => {
      const results = await Promise.all([window.tahtiapuri.sky!.snapshot(input), window.tahtiapuri.sky!.snapshot(input)]);
      return results.map(r => r.ok ? "ready" : r.code).sort();
    }, observation);
    expect(concurrent).toEqual(["BUSY", "ready"]);
    await page.getByRole("button", { name: "Tarkista yhteys uudelleen" }).click();
    await expect(page.getByRole("status", { name: "Yhteyden tila", exact: true })).toHaveText("Yhteys toimii");
  } finally { await app.close(); }
});

test("unavailable canvas reports a drawing error while the keyboard catalogue remains usable", async ({}, info) => {
  const app = await launch(info.outputPath("data"));
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("load");
    await expect(page.getByRole("status", { name: "Yhteyden tila", exact: true })).toHaveText("Yhteys toimii");
    await page.addInitScript(() => { HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext; });
    await page.reload();
    await expect(page.getByRole("alert")).toContainText("Karttaa ei voitu piirtää");
    await fillObservation(page);
    await page.getByRole("combobox", { name: "Kartan kohde", exact: true }).selectOption("Jupiter");
    await expect(page.getByRole("region", { name: "Kohdetiedot", exact: true })).toHaveAttribute("data-object-id", "Jupiter");
  } finally { await app.close(); }
});

test("drawing failure after initialization preserves the catalogue and selected object card", async ({}, info) => {
  const app = await launch(info.outputPath("data"));
  try {
    const page = await app.firstWindow();
    await page.evaluate(() => { CanvasRenderingContext2D.prototype.arc = () => { throw new Error("synthetic canvas loss"); }; });
    await fillObservation(page);
    await expect(page.getByRole("alert")).toContainText("Karttaa ei voitu piirtää");
    await page.getByRole("combobox", { name: "Kartan kohde", exact: true }).selectOption("Jupiter");
    await expect(page.getByRole("region", { name: "Kohdetiedot", exact: true })).toHaveAttribute("data-object-id", "Jupiter");
  } finally { await app.close(); }
});
