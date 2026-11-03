import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
it("does not count valid-looking partial JSON as success or turn missing RAM into zero", () => {
  const parent = join(process.cwd(), ".artifacts/tests/report-fixtures");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "partial-"));
  const base = join(root, ".artifacts/tests/evaluations/local-model"), run = join(base, "synthetic");
  mkdirSync(run, { recursive: true });
  writeFileSync(join(base, "latest-smoke.json"), JSON.stringify({ directory: run }));
  writeFileSync(join(run, "run.json"), JSON.stringify({ actualSettings: { repetitions: 1 }, caveats: [] }));
  const modelId = "qwen3-4b-q4-k-m", backend = "cuda";
  writeFileSync(join(run, "responses.jsonl"), JSON.stringify({ modelId, backend, repetition: 1, caseId: "C01-briefing",
    mode: "json-decision", responseSha256: "a".repeat(64), text: "{}", complete: false, error: "TIMEOUT", warmup: false,
    decision: { json: true, schema: true, semantics: true, tool: true, arguments: true }, ramRssPeakBytes: null,
    vram: { peakMiB: null }, firstTextMs: null, totalMs: 65000 }) + "\n");
  writeFileSync(join(run, "blocks.jsonl"), JSON.stringify({ modelId, backend, repetition: 1, code: 1, done: false }) + "\n");
  writeFileSync(join(run, "loads.jsonl"), JSON.stringify({ modelId, backend, block: 1, vram: { peakMiB: 3500 } }) + "\n");
  let status: number | undefined;
  try { execFileSync(process.execPath, [fileURLToPath(new URL("summarize.mjs", import.meta.url)), "smoke"], { cwd: root, stdio: "pipe" }); }
  catch (error) { status = (error as { status: number }).status; }
  expect(status).toBe(2);
  const summary = JSON.parse(readFileSync(join(run, "summary.json"), "utf8"));
  const group = summary.groups.find((g: { model: string; backend: string }) => g.model === modelId && g.backend === backend);
  expect(group.jsonDecisions).toMatchObject({ total: 1, complete: 0, rawSchema: 1, schema: 0, correctTool: 0, correctArguments: 0 });
  expect(group.ramRssRepeatedPeakMedianBytes).toBeNull();
  expect(group.deviceVramRepeatedPeakMedianMiB).toBe(3500);
  expect(summary.manualReviewsPending).toBe(1);
});
