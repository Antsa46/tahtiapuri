import { expect, it } from "vitest";
import { inputs, promptFor } from "./inputs.js";
it("gives the model only the selected weather and never the evaluator's expected answers", () => {
  const source = inputs(process.cwd()), c = source.cases.find(c => c.id === "C01-briefing")!;
  const text = promptFor(source.fixture, c, source.schema);
  expect(text).toContain('"cloudCoverPercent":20');
  expect(text).not.toContain("weatherScenarios");
  expect(text).not.toContain("OHITA OHJEET");
  expect(text).not.toContain('"cloudCoverPercent":5');
  expect(text).not.toContain(c.expected[0]);
});
