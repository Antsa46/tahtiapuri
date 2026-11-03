import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
const root = process.cwd(), mode = process.argv[2] === "smoke" ? "smoke" : "full";
const base = join(root, ".artifacts/tests/evaluations/local-model");
const directory = JSON.parse(readFileSync(join(base, "latest-" + mode + ".json"), "utf8")).directory;
const jsonl = name => existsSync(join(directory, name)) ? readFileSync(join(directory, name), "utf8").trim().split(/\r?\n/).filter(Boolean).map(x => JSON.parse(x)) : [];
const run = JSON.parse(readFileSync(join(directory, "run.json"), "utf8"));
const rows = jsonl("responses.jsonl"), loads = jsonl("loads.jsonl"), blocks = jsonl("blocks.jsonl");
const review = existsSync(join(directory, "manual-review.json")) ? JSON.parse(readFileSync(join(directory, "manual-review.json"), "utf8")) : { entries: [] };
const statuses = ["pass", "fail", "review-needed", "not-applicable"];
for (const entry of review.entries) {
  if (!["factualSupport", "requiredContent", "missingInformation", "finnish", "instructions"].every(k => statuses.includes(entry[k]))
    || !Array.isArray(entry.evidence) || entry.evidence.length === 0 || !/^[a-f0-9]{64}$/.test(entry.responseSha256))
    throw new Error("Invalid manual review entry");
}
const byResponse = new Map(review.entries.map(r => [r.caseId + "|" + r.responseSha256, r]));
const attempts = rows.filter(r => !r.warmup), expectedCases = mode === "smoke" ? ["C01-briefing"] : JSON.parse(readFileSync(join(root, "tests/evaluations/local-model/cases.json"), "utf8")).modelCases.map(c => c.id);
const median = values => { const a = values.filter(n => typeof n === "number" && Number.isFinite(n)).sort((a,b) => a-b); return a.length ? (a[Math.floor((a.length-1)/2)] + a[Math.floor(a.length/2)]) / 2 : null; };
const dimensions = ["factualSupport", "requiredContent", "missingInformation", "finnish", "instructions"];
const unique = [...new Map(attempts.map(r => [r.caseId + "|" + r.responseSha256, { caseId: r.caseId, responseSha256: r.responseSha256, complete: r.complete, error: r.error ?? null, text: r.text }])).values()];
writeFileSync(join(directory, "review-inputs.json"), JSON.stringify(unique, null, 2));
const maxObserved = values => { const a = values.filter(n => typeof n === "number" && Number.isFinite(n)); return a.length ? Math.max(...a) : null; };
const groups = [];
for (const model of run.actualSettings ? ["qwen3-4b-q4-k-m","qwen3-8b-q4-k-m"] : []) for (const backend of ["cuda","cpu"]) {
  const set = attempts.filter(r => r.modelId === model && r.backend === backend);
  const cold = loads.filter(r => r.modelId === model && r.backend === backend);
  const ownBlocks = blocks.filter(r => r.modelId === model && r.backend === backend);
  const counts = {};
  for (const dim of dimensions) {
    counts[dim] = {};
    for (const r of set) {
      const status = byResponse.get(r.caseId + "|" + r.responseSha256)?.[dim] ?? "review-needed";
      counts[dim][status] = (counts[dim][status] ?? 0) + 1;
    }
  }
  const decisions = set.filter(r => r.mode === "json-decision");
  const validCompleted = decisions.filter(r => r.complete && !r.error);
  const caseTiming = Object.fromEntries(expectedCases.map(id => {
    const s = set.filter(r => r.caseId === id);
    return [id, { attempts: s.length, complete: s.filter(r => r.complete).length,
      firstTextMedianMs: median(s.map(r => r.firstTextMs)), allAttemptTotalMedianMs: median(s.map(r => r.totalMs)),
      outputTokensMedian: median(s.map(r => r.tokens?.usedOutputTokens)) }];
  }));
  const repeatedBlockPeaks = ownBlocks.map(b => {
    const s = rows.filter(r => r.modelId === model && r.backend === backend && r.repetition === b.repetition);
    return { repetition: b.repetition, ramRssPeakBytes: maxObserved(s.map(r => r.ramRssPeakBytes)),
      deviceVramPeakMiB: maxObserved([...s.map(r => r.vram?.peakMiB), ...cold.filter(r=>r.block === b.repetition).map(r=>r.vram?.peakMiB)]),
      deviceVramBeforeMiB: b.beforeGpuMiB, deviceVramAfter750msMiB: b.afterGpuMiB };
  });
  groups.push({ model, backend, expected: expectedCases.length * run.actualSettings.repetitions, attempts: set.length,
    complete: set.filter(r => r.complete).length, blocks: ownBlocks.length, successfulBlocks: ownBlocks.filter(b => b.code === 0 && b.done).length,
    coldProcessReadyMedianMs: median(cold.map(r => r.coldProcessReadyMs)), modelLoadMedianMs: median(cold.map(r => r.modelLoadMs)),
    firstTextMedianMs: median(set.map(r => r.firstTextMs)), allAttemptTotalMedianMs: median(set.map(r => r.totalMs)),
    ramRssRepeatedPeakMedianBytes: median(repeatedBlockPeaks.map(r => r.ramRssPeakBytes)),
    deviceVramRepeatedPeakMedianMiB: median(repeatedBlockPeaks.map(r => r.deviceVramPeakMiB)),
    gpuLayers: [...new Set(cold.map(r => r.gpuLayers))], repeatedBlockPeaks, caseTiming, manualReview: counts,
    jsonDecisions: { total: decisions.length, complete: validCompleted.length, rawParse: decisions.filter(r=>r.decision?.json).length, rawSchema: decisions.filter(r=>r.decision?.schema).length, parse: validCompleted.filter(r=>r.decision?.json).length, schema: validCompleted.filter(r=>r.decision?.schema).length,
      allowedSemantics: validCompleted.filter(r=>r.decision?.semantics).length, correctTool: validCompleted.filter(r=>r.decision?.tool).length,
      correctArguments: validCompleted.filter(r=>r.decision?.arguments).length },
    missingMetrics: { firstText: set.filter(r=>r.firstTextMs == null).length, ram: set.filter(r=>r.ramRssPeakBytes == null).length, vram: set.filter(r=>r.vram?.peakMiB == null).length } });
}
const keys = attempts.map(r => [r.modelId,r.backend,r.repetition,r.caseId].join("|"));
const duplicates = keys.length - new Set(keys).size;
const expected = 4 * run.actualSettings.repetitions * expectedCases.length;
const summary = { run: basename(directory), mode, expected, attempts: attempts.length, complete: attempts.filter(r=>r.complete).length,
  warmups: rows.filter(r=>r.warmup).length, uniqueResponses: unique.length, duplicates,
  manualReviewsPending: attempts.filter(r=> { const review = byResponse.get(r.caseId+"|"+r.responseSha256); return !review || dimensions.some(k=>review[k] === "review-needed"); }).length, groups, caveats: run.caveats };
writeFileSync(join(directory, "summary.json"), JSON.stringify(summary, null, 2));
const f = n => n == null ? "—" : (n / 1000).toFixed(2);
let md = "# Paikallinen 4B/8B-vertailu\n\nAjo: " + basename(directory) + "\n\n"
  + "| Malli | Tausta | Valmis / odotettu | Uusi prosessi valmiina s (med.) | Ensiteksti s (med.) | Kokonaisaika s (med., kaikki yritykset) | RAM RSS GiB (lohkon näytehuippujen med.) | GPU koko laite MiB (lohkon näytehuippujen med.) |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n";
for (const g of groups) md += "| " + g.model + " | " + g.backend + " | " + g.complete + "/" + g.expected + " | " + f(g.coldProcessReadyMedianMs) + " | " + f(g.firstTextMedianMs) + " | " + f(g.allAttemptTotalMedianMs) + " | " + (g.ramRssRepeatedPeakMedianBytes == null ? "—" : (g.ramRssRepeatedPeakMedianBytes / 1024**3).toFixed(2)) + " | " + g.deviceVramRepeatedPeakMedianMiB + " |\n";
md += "\nKäsinarviointeja odottaa: " + summary.manualReviewsPending + ". Ei automaattista tuotantohyväksyntää.\n";
writeFileSync(join(directory, "summary.md"), md);
console.log(JSON.stringify({ run: summary.run, expected, attempts: summary.attempts, complete: summary.complete, warmups: summary.warmups, uniqueResponses: summary.uniqueResponses, duplicates, manualReviewsPending: summary.manualReviewsPending, report: join(directory, "summary.md") }, null, 2));
if (duplicates || attempts.length !== expected || summary.manualReviewsPending) process.exitCode = 2;
