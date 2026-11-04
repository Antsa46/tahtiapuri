import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { backendPid, expectGone, launch } from "../support/electron.js";

test("unexpected worker rejection reaps it before the queued model job starts", async ({}, info) => {
  const data = info.outputPath("data");
  const app = await launch(data, "model-lifecycle");
  let backend: number | undefined;
  let replacement: number | undefined;
  try {
    backend = await backendPid(app);
    const page = await app.firstWindow();
    const jobs = await page.evaluate(async () => {
      const first = await window.tahtiapuri.assistant!.submit({ prompt: "synthetic fatal disposal", backend: "cpu" });
      const second = await window.tahtiapuri.assistant!.submit({ prompt: "synthetic retry", backend: "cpu" });
      return { first, second };
    });
    if (!jobs.first.ok || !jobs.second.ok) throw new Error("Synthetic submissions failed");
    expect(jobs.second.job.state).toBe("queued");
    const firstId = jobs.first.job.id, secondId = jobs.second.job.id;
    await expect.poll(() => page.evaluate(id => window.tahtiapuri.assistant!.get(id), secondId)).toMatchObject({
      job: { state: "completed", text: "synthetic retry" },
    });
    expect(await page.evaluate(id => window.tahtiapuri.assistant!.get(id), firstId)).toMatchObject({
      job: { state: "error", error: "ENGINE_CRASHED", text: "" },
    });
    const events = (await readFile(join(data, "synthetic-worker-events.jsonl"), "utf8")).trim().split("\n")
      .map(line => JSON.parse(line) as { event: string; pid: number });
    expect(events.map(e => e.event)).toEqual(["initialize", "dispose", "previous-exited", "initialize"]);
    expect(events[0]!.pid).toBe(events[1]!.pid);
    replacement = events[3]!.pid; expect(replacement).not.toBe(events[0]!.pid);
    await expectGone(events[0]!.pid); expect(await backendPid(app)).toBe(backend);
  } finally { await app.close(); }
  if (backend) await expectGone(backend); if (replacement) await expectGone(replacement);
  const events = (await readFile(join(data, "synthetic-worker-events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(events.map(e => e.event)).toEqual(["initialize", "dispose", "previous-exited", "initialize", "dispose"]);
});
