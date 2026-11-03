import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { backendPid, expectGone, failingStartup, launch } from "../support/electron.js";

test("status crosses the real sandboxed renderer/main/backend path", async ({}, info) => {
  const app = await launch(info.outputPath("data"));
  const pid = await backendPid(app);
  try {
    const page = await app.firstWindow();
    expect(await app.evaluate(() => process.versions.electron)).toBe("45.2.1");
    await expect(page.getByRole("status", { name: "Yhteyden tila", exact: true }).filter({ hasText: "Yhteys toimii" })).toHaveText("Yhteys toimii");
    await page.getByRole("button", { name: "Tarkista yhteys uudelleen" }).click();
    await expect(page.getByRole("status", { name: "Yhteyden tila", exact: true }).filter({ hasText: "Yhteys toimii" })).toHaveText("Yhteys toimii");
    expect(await page.evaluate(() => ({
      require: typeof (window as unknown as Record<string, unknown>).require,
      process: typeof (window as unknown as Record<string, unknown>).process,
      bridge: Object.keys(window.tahtiapuri),
    }))).toEqual({ require: "undefined", process: "undefined", bridge: ["sky", "assistant", "development", "getStatus"] });
    await page.screenshot({ path: info.outputPath("tahtiapuri.png") });
  } finally { await app.close(); }
  await expectGone(pid);
});

test("rejects malformed messages and a different window even at the same origin", async ({}, info) => {
  const app = await launch(info.outputPath("data"), "probe");
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("status", { name: "Yhteyden tila", exact: true }).filter({ hasText: "Yhteys toimii" })).toHaveText("Yhteys toimii");
    expect(await page.evaluate(() => (window as unknown as { probe: { flags: unknown } }).probe.flags))
      .toEqual({ sandbox: true, contextIsolation: true });
    const malformed = await page.evaluate(async () => {
      const probe = (window as unknown as { probe: { invoke(...args: unknown[]): Promise<unknown> } }).probe;
      try { await probe.invoke({ operation: "shell.exec" }); return "accepted"; } catch { return "denied"; }
    });
    expect(malformed).toBe("denied");
    const foreign = await app.evaluate(async ({ BrowserWindow }, preload) => {
      const owner = BrowserWindow.getAllWindows()[0]!;
      const other = new BrowserWindow({ show: false, webPreferences: { session: owner.webContents.session,
        preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      try {
        await other.loadURL("tahtiapuri://app/index.html");
        return await other.webContents.executeJavaScript("window.probe.invoke().then(() => 'accepted', () => 'denied')");
      } finally { other.destroy(); }
    }, join(process.cwd(), ".artifacts/tests/e2e-build/probe-preload.cjs"));
    expect(foreign).toBe("denied");
    await expect(page.getByRole("status", { name: "Yhteyden tila", exact: true }).filter({ hasText: "Yhteys toimii" })).toHaveText("Yhteys toimii");
  } finally { await app.close(); }
});

test("blocks renderer network requests without contacting an external host", async ({}, info) => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.setHeader("Access-Control-Allow-Origin", "*"); response.end("synthetic"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local test address.");
  const app = await launch(info.outputPath("data"));
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("status", { name: "Yhteyden tila", exact: true }).filter({ hasText: "Yhteys toimii" })).toHaveText("Yhteys toimii");
    const result = await page.evaluate(async url => {
      try { await fetch(url); return "allowed"; } catch { return "blocked"; }
    }, "http://127.0.0.1:" + address.port);
    expect(result).toBe("blocked");
    expect(requests).toBe(0);
  } finally { await app.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("closing the window reaps its backend and a fresh start succeeds", async ({}, info) => {
  const app = await launch(info.outputPath("first"));
  const pid = await backendPid(app);
  const closed = new Promise<void>(resolve => app.process().once("exit", () => resolve()));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await closed;
  await expectGone(pid);
  const next = await launch(info.outputPath("first"));
  const nextPid = await backendPid(next);
  await expect((await next.firstWindow()).getByRole("status", { name: "Yhteyden tila", exact: true })).toHaveText("Yhteys toimii");
  await next.close(); await expectGone(nextPid);
});

for (const scenario of ["early-exit", "unresponsive", "unready-ui"] as const) {
  test("failed startup cleans up: " + scenario, async ({}, info) => {
    await failingStartup(info.outputPath("failure"), scenario);
    const next = await launch(info.outputPath("failure"));
    const pid = await backendPid(next);
    await expect((await next.firstWindow()).getByRole("status", { name: "Yhteyden tila", exact: true })).toHaveText("Yhteys toimii");
    await next.close(); await expectGone(pid);
  });
}

test("backend crash closes stale UI and permits a clean restart", async ({}, info) => {
  const app = await launch(info.outputPath("first"));
  const pid = await backendPid(app);
  const closed = new Promise<void>(resolve => app.process().once("exit", () => resolve()));
  await app.evaluate(({ app }, pid) => {
    if (!app.getAppMetrics().some(metric => metric.pid === pid && metric.name === "Tahtiapuri Backend"))
      throw new Error("Process ownership changed.");
    process.kill(pid);
  }, pid);
  await closed; await expectGone(pid);
  const next = await launch(info.outputPath("first"));
  const nextPid = await backendPid(next);
  await expect((await next.firstWindow()).getByRole("status", { name: "Yhteyden tila", exact: true })).toHaveText("Yhteys toimii");
  await next.close(); await expectGone(nextPid);
});

test("abrupt termination of the owning main does not leave the backend alive", async ({}, info) => {
  const app = await launch(info.outputPath("data"));
  const pid = await backendPid(app);
  const closed = new Promise<void>(resolve => app.process().once("exit", () => resolve()));
  const identities = { launcherPid: app.process().pid, mainPid: await app.evaluate(() => process.pid), backendPid: pid };
  await app.evaluate(() => process.crash()).catch(() => {});
  await closed;
  const observations: unknown[] = [];
  const started = Date.now();
  try {
    await expect.poll(() => {
      try { process.kill(pid, 0); observations.push({ elapsedMs: Date.now() - started, state: "present" }); return true; }
      catch (error) { const code = (error as NodeJS.ErrnoException).code; observations.push({ elapsedMs: Date.now() - started, code }); return code !== "ESRCH"; }
    }, { timeout: 15_000 }).toBe(false);
  } finally { await writeFile(info.outputPath("process-diagnostic.json"), JSON.stringify({ identities, observations }, null, 2)); }
});

test("renderer crash closes its backend and the same profile can reopen", async ({}, info) => {
  const data = info.outputPath("profile");
  const app = await launch(data);
  const pid = await backendPid(app);
  const closed = new Promise<void>(resolve => app.process().once("exit", () => resolve()));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer()).catch(() => {});
  await closed; await expectGone(pid);
  const next = await launch(data);
  const nextPid = await backendPid(next);
  await expect((await next.firstWindow()).getByRole("status", { name: "Yhteyden tila", exact: true })).toHaveText("Yhteys toimii");
  await next.close(); await expectGone(nextPid);
});
