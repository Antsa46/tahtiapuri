import { expect, it } from "vitest";
import { InsufficientMemoryError } from "node-llama-cpp";
import { nativeErrorCode } from "./native-engine.js";
it("maps the SDK's memory error without exhausting host RAM or VRAM", () => {
  expect(nativeErrorCode(new InsufficientMemoryError("synthetic OOM"), false)).toBe("OUT_OF_MEMORY");
});
it("gives cancellation precedence and does not reveal native error details", () => {
  expect(nativeErrorCode(new Error("private file path"), true)).toBe("CANCELLED");
  expect(nativeErrorCode(new Error("private file path"), false)).toBe("ENGINE_UNAVAILABLE");
});
