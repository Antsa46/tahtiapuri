import { expect, test } from "@playwright/test";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";
import type { DevelopmentResult } from "../../../packages/validation/dist/development.js";
import { launch, backendPid, expectGone } from "../support/electron.js";
import { connectMcp } from "../support/mcp.js";
const prompt = (text: string) => ({ prompt: text, backend: "cpu" });
const jobId = (r: DevelopmentResult) => { if (!r.ok || !("job" in r)) throw new Error("Probe rejected."); return r.job.id; };
async function closedByServer(pipe: string, token: string) {
  let bytes = 0;
  const socket = createConnection(pipe);
  socket.on("data", chunk => { bytes += chunk.length; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Unauthorized connection remained open.")); }, 4000);
    socket.on("error", () => {});
    socket.once("connect", () => socket.write(JSON.stringify({ token }) + "\n"));
    socket.once("close", () => { clearTimeout(timer); resolve(); });
  });
  expect(bytes).toBe(0);
}
test("real stdio client sees exactly three tools and default-off denies all probes", async ({}, info) => {
  const data = info.outputPath("data"), app = await launch(data, "model-echo");
  const mcp = await connectMcp(data);
  try {
    const page = await app.firstWindow();
    await expect(page.getByLabel("Salli Codex/MCP-kehitysyhteys")).not.toBeChecked();
    expect(await access(join(data, "mcp/connection.json")).then(() => true, () => false)).toBe(false);
    expect((await mcp.client.listTools()).tools.map(t => t.name).sort()).toEqual(["cancel_probe", "model_probe", "model_status"]);
    expect(await mcp.call("model_status")).toMatchObject({ ok: false, code: "ENGINE_UNAVAILABLE" });
    expect(await mcp.call("model_probe", prompt("synthetic"))).toMatchObject({ ok: false });
    await expect(mcp.client.callTool({ name: "shell.exec", arguments: {} })).rejects.toThrow();
    const bad = await mcp.client.callTool({ name: "model_probe", arguments: { ...prompt("synthetic"), role: "ui" } }).catch(() => null);
    expect(bad === null || bad.isError).toBeTruthy();
  } finally { await mcp.client.close(); await app.close(); }
});
test("MCP and UI share the queue but cannot read or cancel each other's work", async ({}, info) => {
  const data = info.outputPath("data"), app = await launch(data, "model-echo");
  const page = await app.firstWindow(); await page.getByLabel("Salli Codex/MCP-kehitysyhteys").check();
  await expect(page.getByRole("status", { name: "Kehitysyhteyden tila" })).toHaveText("Kehitysyhteys sallittu, ei asiakasta");
  await expect(page.getByRole("status", { name: "Kehitysyhteyden tila" })).toHaveText("Kehitysyhteys sallittu, ei asiakasta");
  const mcp = await connectMcp(data);
  try {
    await expect(page.getByRole("status", { name: "Kehitysyhteyden tila" })).toHaveText("Kehitysyhteys käytössä");
    const id = jobId(await mcp.call("model_probe", prompt("hold:MCP-SYNTHETIC")));
    await expect.poll(async () => await mcp.call("model_status", { jobId: id })).toMatchObject({ job: { state: "running" } });
    expect(await page.evaluate(id => window.tahtiapuri.assistant!.get(id), id)).toMatchObject({ ok: false });
    expect(await page.evaluate(id => window.tahtiapuri.assistant!.cancel(id), id)).toMatchObject({ ok: false });
    const ui = await page.evaluate(() => window.tahtiapuri.assistant!.submit({ prompt: "UI-SYNTHETIC", backend: "cpu" }));
    if (!ui.ok) throw new Error();
    expect(await mcp.call("model_status", { jobId: ui.job.id })).toMatchObject({ ok: false });
    expect(await mcp.call("cancel_probe", { jobId: ui.job.id })).toMatchObject({ ok: false });
    expect(await mcp.call("model_probe", prompt("overflow"))).toMatchObject({ code: "BUSY" });
    expect(await mcp.call("cancel_probe", { jobId: id })).toMatchObject({ job: { state: "cancelled", text: "" } });
    await expect.poll(() => page.evaluate(id => window.tahtiapuri.assistant!.get(id), ui.job.id)).toMatchObject({ job: { state: "completed", text: "UI-SYNTHETIC" } });
    const next = jobId(await mcp.call("model_probe", prompt("MCP-ONLY")));
    await expect.poll(() => mcp.call("model_status", { jobId: next })).toMatchObject({ job: { state: "completed", text: "MCP-ONLY" } });
  } finally { await mcp.client.close(); await app.close(); }
});
test("disable revokes active and queued probes, old capability and old client", async ({}, info) => {
  const data = info.outputPath("data"), app = await launch(data, "model-echo");
  const page = await app.firstWindow(); await page.getByLabel("Salli Codex/MCP-kehitysyhteys").check();
  await expect(page.getByRole("status", { name: "Kehitysyhteyden tila" })).toHaveText("Kehitysyhteys sallittu, ei asiakasta");
  const mcp = await connectMcp(data);
  try {
    const previous = JSON.parse(await readFile(join(data, "mcp/connection.json"), "utf8"));
    const first = jobId(await mcp.call("model_probe", prompt("hold:active")));
    const second = jobId(await mcp.call("model_probe", prompt("queued")));
    await page.getByLabel("Salli Codex/MCP-kehitysyhteys").uncheck();
    await expect(page.getByRole("status", { name: "Kehitysyhteyden tila" })).toHaveText("Kehitysyhteys pois päältä");
    expect(await mcp.call("model_status", { jobId: first })).toMatchObject({ ok: false });
    expect(await access(join(data, "mcp/connection.json")).then(() => true, () => false)).toBe(false);
    await page.getByLabel("Salli Codex/MCP-kehitysyhteys").check();
  await expect(page.getByRole("status", { name: "Kehitysyhteyden tila" })).toHaveText("Kehitysyhteys sallittu, ei asiakasta");
    await expect(page.getByRole("status", { name: "Kehitysyhteyden tila" })).toHaveText("Kehitysyhteys sallittu, ei asiakasta");
    const current = JSON.parse(await readFile(join(data, "mcp/connection.json"), "utf8"));
    expect(current.token === previous.token).toBe(false);
    await closedByServer(current.pipe, previous.token);
    await closedByServer(current.pipe, "0".repeat(64));
    expect(await mcp.call("model_status")).toMatchObject({ ok: false });
    const next = await connectMcp(data);
    try {
      expect(await next.call("model_status", { jobId: first })).toMatchObject({ ok: false });
      expect(await next.call("model_status", { jobId: second })).toMatchObject({ ok: false });
      const id = jobId(await next.call("model_probe", prompt("new-session")));
      await expect.poll(() => next.call("model_status", { jobId: id })).toMatchObject({ job: { state: "completed", text: "new-session" } });
    } finally { await next.client.close(); }
  } finally { await mcp.client.close(); await app.close(); }
});
test("stdio disconnect cancels MCP work and preserves the queued UI job", async ({}, info) => {
  const data = info.outputPath("data"), app = await launch(data, "model-echo");
  const page = await app.firstWindow(); await page.getByLabel("Salli Codex/MCP-kehitysyhteys").check();
  await expect(page.getByRole("status", { name: "Kehitysyhteyden tila" })).toHaveText("Kehitysyhteys sallittu, ei asiakasta");
  const mcp = await connectMcp(data);
  try {
    jobId(await mcp.call("model_probe", prompt("hold:disconnect")));
    const ui = await page.evaluate(() => window.tahtiapuri.assistant!.submit({ prompt: "UI-SURVIVES", backend: "cpu" }));
    if (!ui.ok) throw new Error();
    await mcp.client.close();
    await expect.poll(() => page.evaluate(id => window.tahtiapuri.assistant!.get(id), ui.job.id)).toMatchObject({ job: { state: "completed", text: "UI-SURVIVES" } });
    await expect(page.getByRole("status", { name: "Kehitysyhteyden tila" })).toHaveText("Kehitysyhteys sallittu, ei asiakasta");
  } finally { await mcp.client.close(); await app.close(); }
});
test("application shutdown revokes MCP and reaps backend/model; restart starts closed", async ({}, info) => {
  const data = info.outputPath("data"), app = await launch(data, "model-echo");
  const page = await app.firstWindow(); const pid = await backendPid(app);
  await page.getByLabel("Salli Codex/MCP-kehitysyhteys").check();
  await expect(page.getByRole("status", { name: "Kehitysyhteyden tila" })).toHaveText("Kehitysyhteys sallittu, ei asiakasta");
  const mcp = await connectMcp(data);
  try {
    const id = jobId(await mcp.call("model_probe", prompt("hold:closing")));
    await expect.poll(() => mcp.call("model_status", { jobId: id })).toMatchObject({ job: { state: "running" } });
    const modelPid = await app.evaluate(({ app }) => app.getAppMetrics().find(m => m.name === "Tahtiapuri Model")?.pid);
    await app.close(); await expectGone(pid); if (modelPid) await expectGone(modelPid);
    expect(await mcp.call("model_status")).toMatchObject({ ok: false });
    const next = await launch(data, "model-echo");
    try { await expect((await next.firstWindow()).getByLabel("Salli Codex/MCP-kehitysyhteys")).not.toBeChecked(); }
    finally { await next.close(); }
  } finally { await mcp.client.close(); await app.close().catch(() => {}); }
});
test("development controls reject malformed inputs and foreign same-origin renderer", async ({}, info) => {
  const app = await launch(info.outputPath("data"), "probe");
  try {
    const page = await app.firstWindow();
    const denied = await page.evaluate(async () => {
      const probe = (window as unknown as { probe: { development(...args: unknown[]): Promise<unknown> } }).probe;
      try { await probe.development("yes"); return false; } catch { return true; }
    });
    expect(denied).toBe(true);
    const foreign = await app.evaluate(async ({ BrowserWindow }, preload) => {
      const owner = BrowserWindow.getAllWindows()[0]!;
      const other = new BrowserWindow({ show: false, webPreferences: { session: owner.webContents.session, preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      try {
        await other.loadURL("tahtiapuri://app/index.html");
        return await other.webContents.executeJavaScript("window.probe.development(true).then(() => 'accepted', () => 'denied')");
      } finally { other.destroy(); }
    }, join(process.cwd(), ".artifacts/tests/e2e-build/probe-preload.cjs"));
    expect(foreign).toBe("denied");
  } finally { await app.close(); }
});
