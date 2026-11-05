import { expect, it } from "vitest";
import { isModelInput, isEngineReply, isEngineInfo, NATIVE_ENGINE_VERSION } from "./assistant.js";
it("accepts only bounded prompts and explicit CPU/CUDA choices", () => {
  expect(isModelInput({ prompt: "Mitä taivaalla?", backend: "cpu" })).toBe(true);
  for (const input of [{ prompt: "x".repeat(2001), backend: "cpu" }, { prompt: "a", backend: "auto" },
    { prompt: "a", backend: "cpu", modelPath: "private" }, { prompt: "", backend: "cpu" }]) expect(isModelInput(input)).toBe(false);
});
it("rejects unbounded or untyped model replies", () => {
  expect(isEngineReply({ text: "x".repeat(8193), error: null, info: null })).toBe(false);
  expect(isEngineReply({ text: "", error: "execute-shell", info: null })).toBe(false);
});

it("accepts the pinned native engine only as CPU, retaining SDK CPU/CUDA identity", () => {
  const info = { backend: "cpu", gpuLayers: 0, loadMs: 1, generationMs: 1, contextSize: 4096,
    engineVersion: NATIVE_ENGINE_VERSION, modelId: "qwen3-4b-q4-k-m" };
  expect(isEngineInfo(info)).toBe(true);
  expect(isEngineInfo({ ...info, backend: "cuda", gpuLayers: 20 })).toBe(false);
  expect(isEngineInfo({ ...info, engineVersion: "unknown" })).toBe(false);
  expect(isEngineInfo({ ...info, engineVersion: "3.22.2", backend: "cuda", gpuLayers: 20 })).toBe(true);
});
