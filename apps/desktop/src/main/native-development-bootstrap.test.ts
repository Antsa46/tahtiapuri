import { expect, it } from "vitest";
import { encodeNativeBootstrap, decodeNativeBootstrap } from "./native-development-bootstrap.js";
const value = { main: { pid: 0x01020304, creationTime: 0x0807060504030201n }, pipeNonce: "11".repeat(16),
  ticket: { generation: "22".repeat(16), token: "33".repeat(32) } };
const golden = "544d424f4f543100010000006000000004030201000000000102030405060708" + "11".repeat(16) + "22".repeat(16) + "33".repeat(32);
it("matches the fixed native 96-byte golden descriptor without paths or arguments", () => {
  const bytes = encodeNativeBootstrap(value); expect(bytes.toString("hex")).toBe(golden);
  expect(decodeNativeBootstrap(bytes)).toEqual(value); bytes.fill(0); expect(value.ticket.token).toBe("33".repeat(32));
});
it("rejects length, raw magic, version, size, reserved bytes and empty identity", () => {
  const bytes = Buffer.from(golden, "hex");
  for (const input of [bytes.subarray(0, 95), Buffer.concat([bytes, Buffer.from([0])])]) expect(() => decodeNativeBootstrap(input)).toThrow();
  for (const offset of [0, 7, 8, 12, 20, 23]) { const bad = Buffer.from(bytes); bad[offset] ^= 0x80; expect(() => decodeNativeBootstrap(bad)).toThrow(); }
  for (const [start, end] of [[16, 20], [24, 32]]) { const bad = Buffer.from(bytes); bad.fill(0, start, end); expect(() => decodeNativeBootstrap(bad)).toThrow(); }
});
it("refuses rounded creation times and noncanonical tokens or pipe selectors", () => {
  for (const bad of [{ ...value, main: { ...value.main, creationTime: 123 as unknown as bigint } },
    { ...value, main: { ...value.main, creationTime: -1n } }, { ...value, main: { ...value.main, pid: 0x100000000 } },
    { ...value, pipeNonce: "\\\\server\\pipe" }, { ...value, ticket: { ...value.ticket, token: "A".repeat(64) } }])
    expect(() => encodeNativeBootstrap(bad)).toThrow();
});
