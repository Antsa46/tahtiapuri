import { expect, it } from "vitest";
import { decodeNativeMainIdentity } from "./native-main-identity-codec.js";
const valid = '{"pid":1234,"creationTime":"fedcba9876543210"}';
it("accepts the exact native LF and CRLF forms without losing FILETIME bits", () => {
  for (const newline of ["\n", "\r\n"]) {
    const result = decodeNativeMainIdentity(Buffer.from(valid + newline), 1234);
    expect(result).toEqual({ pid: 1234, creationTime: 0xfedcba9876543210n }); expect(Object.isFrozen(result)).toBe(true);
  }
});
it("rejects a different Main PID", () => {
  expect(() => decodeNativeMainIdentity(Buffer.from(valid + "\n"), 1235)).toThrow();
});
it("rejects zero or malformed creation times", () => {
  for (const value of ["0000000000000000", "FEDCBA9876543210", "1234", "gggggggggggggggg"])
    expect(() => decodeNativeMainIdentity(Buffer.from(valid.replace("fedcba9876543210", value) + "\n"), 1234)).toThrow();
});
it("rejects extra fields, whitespace, reordered keys and extra lines", () => {
  for (const value of [valid + "\n\n", valid, " " + valid + "\n", valid.replace("}", ',"extra":1}') + "\n",
    '{"creationTime":"fedcba9876543210","pid":1234}\n'])
    expect(() => decodeNativeMainIdentity(Buffer.from(value), 1234)).toThrow();
});
it("rejects leading-zero PIDs and invalid expected DWORD PIDs", () => {
  expect(() => decodeNativeMainIdentity(Buffer.from(valid.replace("1234", "01234") + "\n"), 1234)).toThrow();
  for (const pid of [0, -1, 1.5, 0x100000000, NaN]) expect(() => decodeNativeMainIdentity(Buffer.from(valid + "\n"), pid)).toThrow();
});
it("rejects high-bit bytes that an ASCII conversion would mask into protocol characters", () => {
  const bytes = Buffer.from(valid + "\n"); bytes[0] = 0xfb;
  expect(bytes.toString("ascii")).toBe(valid + "\n");
  expect(() => decodeNativeMainIdentity(bytes, 1234)).toThrow("Non-ASCII");
});
it("rejects a BOM, an oversized receipt and concurrently mutable shared input", () => {
  for (const value of [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(valid + "\n")]), Buffer.alloc(129),
    new Uint8Array(new SharedArrayBuffer(64))]) expect(() => decodeNativeMainIdentity(value, 1234)).toThrow();
});
