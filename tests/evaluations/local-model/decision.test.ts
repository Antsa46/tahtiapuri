import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { assessDecision } from "./decision.js";
const cases = JSON.parse(readFileSync(new URL("cases.json", import.meta.url), "utf8"));
for (const c of cases.hostValidationCases) it("rejects the independent host fixture " + c.id, () => {
  const r = assessDecision(JSON.stringify(c.response), ["jupiter", "saturn", "moon"], "2030-01-15T18:00:00Z");
  expect(c.expected === "reject-schema" ? r.schema : r.semantics).toBe(false);
});
it("distinguishes valid JSON and allowed semantics from the wrong requested target", () => {
  const expected = { action: "sky.getTarget" as const, targetId: "jupiter", atUtc: "2030-01-15T18:00:00Z" };
  const r = assessDecision(JSON.stringify({ ...expected, targetId: "saturn", text: "" }), ["jupiter", "saturn"], expected.atUtc, expected);
  expect(r).toMatchObject({ json: true, schema: true, semantics: true, tool: true, arguments: false });
});
it("does not repair fenced JSON or accept an array", () => {
  expect(assessDecision("```json\n{}\n```", [], "").json).toBe(false);
  expect(assessDecision("[]", [], "").schema).toBe(false);
});
