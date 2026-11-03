import { expect, it } from "vitest";
import { readFrames, RESPONSE_FRAME_BYTES } from "./development-framing.js";
it("accepts coalesced replies and UTF-8 split across logical chunks without a batch-size false rejection", () => {
  const line = JSON.stringify({ text: "星".repeat(8192) });
  const combined = readFrames("", (line + "\n").repeat(3), RESPONSE_FRAME_BYTES);
  expect(combined.frames).toEqual([line, line, line]); expect(combined.remainder).toBe("");
  const first = readFrames("", line.slice(0, 500), RESPONSE_FRAME_BYTES);
  const second = readFrames(first.remainder, line.slice(500) + "\n", RESPONSE_FRAME_BYTES);
  expect(second.frames).toEqual([line]);
});
it("bounds individual frames, incomplete remainders and batches independently", () => {
  expect(() => readFrames("", "ä".repeat(9), 16)).toThrow();
  expect(() => readFrames("", "x".repeat(17) + "\n", 16)).toThrow();
  expect(() => readFrames("", "a\n".repeat(5), 16)).toThrow();
  expect(readFrames("", "1234567890\n".repeat(3), 16).frames).toHaveLength(3);
});
