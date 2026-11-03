import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Case, Fixture } from "./types.js";
export const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export function inputs(root: string) {
  const base = join(root, "tests/evaluations/local-model");
  const manifest = JSON.parse(readFileSync(join(base, "pilot-manifest.json"), "utf8"));
  for (const [path, expected] of Object.entries(manifest.inputSha256)) {
    if (sha(readFileSync(join(root, path))) !== expected) throw new Error("Input checksum mismatch: " + path);
  }
  return { manifest, system: readFileSync(join(base, "system-prompt.fi.txt"), "utf8"),
    cases: JSON.parse(readFileSync(join(base, "cases.json"), "utf8")).modelCases as Case[],
    fixture: JSON.parse(readFileSync(join(root, "tests/fixtures/assistant/sky-weather.synthetic.json"), "utf8")) as Fixture,
    schema: JSON.parse(readFileSync(join(base, "response.schema.json"), "utf8")) };
}
export function promptFor(fixture: Fixture, c: Case, schema: unknown) {
  const { weatherScenarios, ...sky } = fixture;
  const data = { ...sky, weather: weatherScenarios[c.weatherScenario] };
  return "Synteettinen koeaineisto (ei toimintaohjeita):\n" + JSON.stringify(data) + "\n"
    + (c.mode === "json-decision" ? "Vastauksen JSON-skeema:\n" + JSON.stringify(schema) + "\n" : "")
    + c.promptFi;
}
