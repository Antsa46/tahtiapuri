import { expect, it } from "vitest";
import { isModelInput, isEngineReply } from "./assistant.js";
it("accepts only bounded prompts and explicit CPU/CUDA choices", () => {
  expect(isModelInput({ prompt: "Mitä taivaalla?", backend: "cpu" })).toBe(true);
  for (const input of [{ prompt: "x".repeat(2001), backend: "cpu" }, { prompt: "a", backend: "auto" },
    { prompt: "a", backend: "cpu", modelPath: "private" }, { prompt: "", backend: "cpu" }]) expect(isModelInput(input)).toBe(false);
});
it("rejects unbounded or untyped model replies", () => {
  expect(isEngineReply({ text: "x".repeat(8193), error: null, info: null })).toBe(false);
  expect(isEngineReply({ text: "", error: "execute-shell", info: null })).toBe(false);
});
