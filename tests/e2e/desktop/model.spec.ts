import { connectMcp } from "../support/mcp.js";
import { expect, test } from "@playwright/test";
import { writeFile, readFile } from "node:fs/promises";
import { backendPid, expectGone, launch } from "../support/electron.js";
for (const backend of ["cpu", "cuda"] as const) {
  test("real Qwen3 4B answer via UI and explicit " + backend, async ({}, info) => {
    const app = await launch(info.outputPath("data"), "model");
    const mainBackend = await backendPid(app);
    try {
      const page = await app.firstWindow();
      await page.getByLabel("Laskentatapa", { exact: true }).selectOption(backend);
      await page.getByLabel("Kysymys paikalliselle mallille").fill("Synteettinen koe: Jupiterin korkeus on 36,5 astetta ja pilvisyys 20 %. Tiivistä nämä annetut luvut suomeksi kahdessa virkkeessä. Älä lisää muita lukuja.");
      await page.getByRole("button", { name: "Kysy mallilta", exact: true }).click();
      await expect(page.getByTestId("model-answer")).toBeVisible({ timeout: 150_000 });
      await expect(page.getByTestId("model-answer")).toContainText(/Jupiter/i);
      const id = await page.locator("[data-job-id]").getAttribute("data-job-id");
      const result = await page.evaluate(id => window.tahtiapuri.assistant!.get(id!), id);
      expect(result).toMatchObject({ ok: true, job: { state: "completed", info: { backend, contextSize: 4096 } } });
      await writeFile(info.outputPath("real-answer.json"), JSON.stringify(result, null, 2));
      await page.screenshot({ path: info.outputPath("answer.png"), fullPage: true });
      const modelPid = await app.evaluate(({ app }) => app.getAppMetrics().find(m => m.name === "Tahtiapuri Model")?.pid);
      await app.close(); await expectGone(mainBackend); if (modelPid) await expectGone(modelPid);
    } finally { await app.close().catch(() => {}); }
  });
}
test("real generation can be cancelled and the next request succeeds", async ({}, info) => {
  const app = await launch(info.outputPath("data"), "model");
  try {
    const page = await app.firstWindow();
    const first = await page.evaluate(() => window.tahtiapuri.assistant!.submit({ prompt: "Luettele luvut yhdestä viiteensataan ja selitä jokainen pitkällä virkkeellä.", backend: "cuda" }));
    if (!first.ok) throw new Error("Submit failed.");
    await expect.poll(async () => {
      const r = await page.evaluate(id => window.tahtiapuri.assistant!.get(id), first.job.id);
      return r.ok ? r.job.state : "error";
    }, { timeout: 150_000 }).toBe("running");
    const cancelled = await page.evaluate(id => window.tahtiapuri.assistant!.cancel(id), first.job.id);
    expect(cancelled).toMatchObject({ ok: true, job: { state: "cancelled", text: "" } });
    const second = await page.evaluate(() => window.tahtiapuri.assistant!.submit({ prompt: "Vastaa lyhyesti: mikä on Aurinko?", backend: "cuda" }));
    if (!second.ok) throw new Error("Second submit failed.");
    await expect.poll(async () => {
      const r = await page.evaluate(id => window.tahtiapuri.assistant!.get(id), second.job.id);
      return r.ok ? r.job.state : "error";
    }, { timeout: 150_000 }).toBe("completed");
    expect(await page.evaluate(id => window.tahtiapuri.assistant!.get(id), first.job.id)).toMatchObject({ job: { state: "cancelled", text: "" } });
  } finally { await app.close(); }
});
for (const scenario of ["model-oom", "model-invalid"] as const) {
  test("controlled fault: " + scenario, async ({}, info) => {
    const app = await launch(info.outputPath("data"), scenario);
    try {
      const page = await app.firstWindow();
      await page.getByRole("button", { name: "Kysy mallilta", exact: true }).click();
      await expect(page.getByRole("alert")).toHaveText(scenario === "model-oom" ? "Muisti ei riittänyt mallin ajamiseen." : "Mallitiedosto puuttuu tai sen tarkiste ei täsmää.", { timeout: 150_000 });
      await expect(page.getByRole("status", { name: "Yhteyden tila", exact: true })).toHaveText("Yhteys toimii");
    } finally { await app.close(); }
  });
}
test("model-process crash and closing during loading reap owned workers", async ({}, info) => {
  const app = await launch(info.outputPath("data"), "model");
  const mainBackend = await backendPid(app);
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Kysy mallilta", exact: true }).click();
  const modelPid = await app.evaluate(async ({ app }) => {
    for (let n = 0; n < 50; n++) {
      const pid = app.getAppMetrics().find(m => m.name === "Tahtiapuri Model")?.pid;
      if (pid) return pid; await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Model process missing.");
  });
  await app.evaluate(({ app }, pid) => {
    if (!app.getAppMetrics().some(m => m.pid === pid && m.name === "Tahtiapuri Model")) throw new Error("Ownership changed.");
    process.kill(pid);
  }, modelPid);
  await expect(page.getByRole("alert")).toHaveText(/Malliprosessi pysähtyi/, { timeout: 10_000 });
  await expect(page.getByRole("status", { name: "Yhteyden tila", exact: true })).toHaveText("Yhteys toimii");
  await page.getByRole("button", { name: "Kysy mallilta", exact: true }).click();
  const nextPid = await app.evaluate(async ({ app }) => {
    for (let n = 0; n < 50; n++) {
      const pid = app.getAppMetrics().find(m => m.name === "Tahtiapuri Model")?.pid;
      if (pid) return pid; await new Promise(resolve => setTimeout(resolve, 50));
    } throw new Error("Replacement model missing.");
  });
  await app.close(); await expectGone(modelPid); await expectGone(nextPid); await expectGone(mainBackend);
});

test("actual SDK binary-test child exits after abrupt owner loss", async ({}, info) => {
  const data = info.outputPath("data"); const app = await launch(data, "model-helper-hold");
  const backend = await backendPid(app); const page = await app.firstWindow();
  await page.getByLabel("Laskentatapa", { exact: true }).selectOption("cuda");
  await page.getByRole("button", { name: "Kysy mallilta", exact: true }).click();
  let helper: { pid: number; parent: number; held: boolean } | undefined;
  await expect.poll(async () => {
    helper = await readFile(data + "/sdk-helper.json", "utf8").then(text => JSON.parse(text)).catch(() => undefined);
    return helper?.held;
  }, { timeout: 30_000 }).toBe(true);
  if (!helper) throw new Error("SDK helper missing");
  process.kill(helper.pid, 0);
  const closed = new Promise<void>(resolve => app.process().once("exit", () => resolve()));
  await app.evaluate(() => process.crash()).catch(() => {}); await closed;
  await expectGone(helper.pid); await expectGone(helper.parent); await expectGone(backend);
  await writeFile(info.outputPath("sdk-child-cleanup.json"), JSON.stringify({ ...helper, exited: true }));
});

test("real 4B contexts stay separate across UI, stdio MCP and cancellation", async ({}, info) => {
  const data = info.outputPath("data"), app = await launch(data, "model");
  const pid = await backendPid(app), page = await app.firstWindow();
  await page.getByLabel("Salli Codex/MCP-kehitysyhteys").check();
  await expect(page.getByRole("status", { name: "Kehitysyhteyden tila" })).toHaveText("Kehitysyhteys sallittu, ei asiakasta");
  const mcp = await connectMcp(data);
  const uiTag = "SYNTEETTINEN_UI_9D4E7A2C", mcpTag = "SYNTEETTINEN_MCP_6C1F8B3D";
  const evidence: unknown[] = [];
  let modelPid: number | undefined;
  const question = "Mikä koetunniste on annettu tässä keskustelussa? Jos sitä ei ole annettu, vastaa EI_TUNNISTETTA. Älä keksi tunnistetta.";
  async function ui(prompt: string) {
    const submitted = await page.evaluate(prompt => window.tahtiapuri.assistant!.submit({ prompt, backend: "cuda" }), prompt);
    if (!submitted.ok) throw new Error("UI submission failed.");
    await expect.poll(() => page.evaluate(id => window.tahtiapuri.assistant!.get(id), submitted.job.id),
      { timeout: 150_000, intervals: [100] }).toMatchObject({ job: { state: "completed" } });
    const result = await page.evaluate(id => window.tahtiapuri.assistant!.get(id), submitted.job.id);
    if (!result.ok) throw new Error(); evidence.push(result);
    return result.job.text;
  }
  async function probe(prompt: string) {
    const submitted = await mcp.call("model_probe", { prompt, backend: "cuda" });
    if (!submitted.ok || !("job" in submitted)) throw new Error("MCP submission failed.");
    await expect.poll(() => mcp.call("model_status", { jobId: submitted.job.id }),
      { timeout: 150_000, intervals: [100] }).toMatchObject({ job: { state: "completed" } });
    const result = await mcp.call("model_status", { jobId: submitted.job.id });
    if (!result.ok || !("job" in result)) throw new Error(); evidence.push(result);
    return result.job.text;
  }
  try {
    expect(await ui("Toista täsmälleen tämä koetunniste, älä lisää muuta: " + uiTag)).toContain(uiTag);
    const mcpUnknown = await probe(question); expect(mcpUnknown.trim().length).toBeGreaterThan(0); expect(mcpUnknown).not.toContain(uiTag);
    expect(await probe("Toista täsmälleen tämä koetunniste, älä lisää muuta: " + mcpTag)).toContain(mcpTag);
    const uiUnknown = await ui(question); expect(uiUnknown.trim().length).toBeGreaterThan(0); expect(uiUnknown).not.toContain(mcpTag);
    const long = await mcp.call("model_probe", { prompt: "Koetunniste on " + mcpTag + ". Luettele luvut yhdestä viiteensataan ja selitä jokainen pitkällä virkkeellä.", backend: "cuda" });
    if (!long.ok || !("job" in long)) throw new Error();
    await expect.poll(() => mcp.call("model_status", { jobId: long.job.id }),
      { timeout: 150_000, intervals: [100] }).toMatchObject({ job: { state: "running" } });
    expect(await mcp.call("cancel_probe", { jobId: long.job.id })).toMatchObject({ job: { state: "cancelled", text: "" } });
    const afterCancel = await ui(question); expect(afterCancel.trim().length).toBeGreaterThan(0); expect(afterCancel).not.toContain(mcpTag);
    modelPid = await app.evaluate(({ app }) => app.getAppMetrics().find(m => m.name === "Tahtiapuri Model")?.pid);
    await writeFile(info.outputPath("mcp-context-evidence.json"), JSON.stringify(evidence, null, 2));
  } finally { await mcp.client.close(); await app.close(); }
  await expectGone(pid); if (modelPid) await expectGone(modelPid);
});

test("real CPU worker brief reply and bounded phase evidence", async ({}, info) => {
  const app = await launch(info.outputPath("data"), "model");
  let backend: number | undefined;
  const states: { elapsedMs: number; state: string }[] = [];
  let modelPid: number | undefined;
  try {
    backend = await backendPid(app);
    const page = await app.firstWindow();
    const submitted = await page.evaluate(() => window.tahtiapuri.assistant!.submit({ prompt: "Vastaa vain yhdellä sanalla: Jupiter", backend: "cpu" }));
    if (!submitted.ok) throw new Error("Synthetic CPU submission failed");
    const started = Date.now();
    await expect.poll(async () => {
      const result = await page.evaluate(id => window.tahtiapuri.assistant!.get(id), submitted.job.id);
      const state = result.ok ? result.job.state : result.code;
      if (states.at(-1)?.state !== state) states.push({ elapsedMs: Date.now() - started, state });
      return result.ok && ["completed", "error", "cancelled"].includes(state);
    }, { timeout: 160_000, intervals: [500] }).toBe(true);
    const result = await page.evaluate(id => window.tahtiapuri.assistant!.get(id), submitted.job.id);
    await writeFile(info.outputPath("brief-cpu-result.json"), JSON.stringify({ states, result }, null, 2));
    expect(result).toMatchObject({ ok: true, job: { state: "completed", info: { backend: "cpu", gpuLayers: 0 } } });
    if (!result.ok) throw new Error("CPU result unavailable");
    expect(result.job.text.trim().length).toBeGreaterThan(0);
  } finally {
    modelPid = await app.evaluate(({ app }) => app.getAppMetrics().find(m => m.name === "Tahtiapuri Model")?.pid).catch(() => undefined);
    try { await writeFile(info.outputPath("brief-cpu-phases.json"), JSON.stringify(states)); }
    finally { await app.close(); if (backend) await expectGone(backend); if (modelPid) await expectGone(modelPid); }
  }
});
