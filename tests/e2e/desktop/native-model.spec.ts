import { expect, test, type TestInfo } from "@playwright/test";
import { readdir, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { launch, backendPid, expectGone } from "../support/electron.js";
import { connectMcp } from "../support/mcp.js";
function dataPath(info: TestInfo) {
  const runId = process.env.TAHTIAPURI_NATIVE_E2E_RUN;
  if (!runId || !/^[a-f0-9]{32}$/.test(runId)) throw new Error("Missing bounded run identity");
  const testId = createHash("sha256").update(info.testId).digest("hex").slice(0, 12);
  // Never put persistent native ownership/staging under Playwright outputDir.
  return resolve(".artifacts/tests/native-desktop/runs", runId, "application", testId);
}
const prompt = "Vastaa vain yhdellä sanalla: Jupiter";
const emptyWork = async (data: string) => (await readdir(join(data, "native-model")).catch(() => ["missing"])).length;
test("real native CPU answer crosses Electron renderer, backend queue and isolated worker", async ({}, info) => {
  const data = dataPath(info), app = await launch(data, "native-model"), pid = await backendPid(app);
  try {
    const page = await app.firstWindow();
    await page.getByLabel("Kysymys paikalliselle mallille").fill(prompt);
    await page.getByRole("button", { name: "Kysy mallilta", exact: true }).click();
    await expect(page.getByTestId("model-answer")).toHaveText(/^Jupiter\.?$/, { timeout: 190000 });
    const id = await page.locator("[data-job-id]").getAttribute("data-job-id");
    const result = await page.evaluate(id => window.tahtiapuri.assistant!.get(id!), id);
    expect(result).toMatchObject({ ok: true, job: { state: "completed", error: null,
      info: { engineVersion: "llama.cpp-v0.9.0-cpu", backend: "cpu", gpuLayers: 0, contextSize: 4096 } } });
    expect(await emptyWork(data)).toBe(0);
    await writeFile(info.outputPath("native-answer.json"), JSON.stringify(result, null, 2));
    await app.close(); await expectGone(pid);
  } finally { await app.close().catch(() => {}); }
});
test("real UI and stdio MCP share the native queue and revoke only their own work", async ({}, info) => {
  const data = dataPath(info), app = await launch(data, "native-model"), pid = await backendPid(app);
  let mcp: Awaited<ReturnType<typeof connectMcp>> | undefined;
  try {
    const page = await app.firstWindow();
    await expect(page.getByLabel("Salli Codex/MCP-kehitysyhteys")).not.toBeChecked();
    await page.getByLabel("Salli Codex/MCP-kehitysyhteys").check(); mcp = await connectMcp(data);
    await page.getByLabel("Kysymys paikalliselle mallille").fill(prompt);
    await page.getByRole("button", { name: "Kysy mallilta", exact: true }).click();
    await expect(page.locator("[data-job-id]")).toHaveAttribute("data-job-id", /^[a-f0-9-]{36}$/);
    const uiId = (await page.locator("[data-job-id]").getAttribute("data-job-id"))!;
    const ui = await page.evaluate(id => window.tahtiapuri.assistant!.get(id), uiId);
    if (!ui.ok) throw new Error("UI submit failed");
    await expect.poll(() => page.evaluate(id => window.tahtiapuri.assistant!.get(id), ui.job.id), { timeout: 30000 }).toMatchObject({ job: { state: "running" } });
    const queued = await mcp.call("model_probe", { prompt, backend: "cpu" });
    if (!queued.ok || !("job" in queued)) throw new Error("MCP submit failed");
    expect(queued.job.state).toBe("queued");
    expect(await mcp.call("model_status", { jobId: ui.job.id })).toMatchObject({ ok: false });
    expect(await mcp.call("cancel_probe", { jobId: ui.job.id })).toMatchObject({ ok: false });
    expect(await page.evaluate(id => window.tahtiapuri.assistant!.get(id), queued.job.id)).toMatchObject({ ok: false });
    expect(await page.evaluate(id => window.tahtiapuri.assistant!.cancel(id), queued.job.id)).toMatchObject({ ok: false });
    await page.getByRole("button", { name: "Peru työ", exact: true }).click();
    await expect.poll(() => page.evaluate(id => window.tahtiapuri.assistant!.get(id), ui.job.id)).toMatchObject({ job: { state: "cancelled" } });
    await expect.poll(() => mcp!.call("model_status", { jobId: queued.job.id }), { timeout: 30000 }).toMatchObject({ job: { state: "running" } });
    // Disabling the actual UI setting must close this real MCP-owned model job.
    await page.getByLabel("Salli Codex/MCP-kehitysyhteys").uncheck();
    await expect(page.getByRole("status", { name: "Kehitysyhteyden tila" })).toHaveText("Kehitysyhteys pois päältä");
    expect(await mcp.call("model_status", { jobId: queued.job.id })).toMatchObject({ ok: false });
    await expect.poll(() => emptyWork(data), { timeout: 15000 }).toBe(0);
    expect(await access(join(data, "mcp/connection.json")).then(() => true, () => false)).toBe(false);
    await mcp.client.close(); await app.close(); await expectGone(pid);
    const next = await launch(data, "native-model");
    try { await expect((await next.firstWindow()).getByLabel("Salli Codex/MCP-kehitysyhteys")).not.toBeChecked(); }
    finally { await next.close(); }
  } finally { await mcp?.client.close().catch(() => {}); await app.close().catch(() => {}); }
});
