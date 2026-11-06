import { afterEach, expect, it, vi } from "vitest";
import { ControlKind, NativeControl, NativeControlReader, encodeControlFrame } from "./native-development-wire.js";
afterEach(() => vi.useRealTimers());
it("decodes fragmented exact control fields and adjacent frames without retaining the input buffer", () => {
  const got: Buffer[] = [], fail = vi.fn();
  const reader = new NativeControlReader("to-main", frame => got.push(frame.body), fail);
  const hello = encodeControlFrame({ kind: ControlKind.hello, body: Buffer.alloc(48, 7) }, 1, "to-main");
  const clean = encodeControlFrame({ kind: ControlKind.clean, body: Buffer.alloc(0) }, 2, "to-main");
  for (const byte of hello) reader.write(Buffer.from([byte]));
  reader.write(clean); hello.fill(0); reader.end();
  expect(got).toEqual([Buffer.alloc(48, 7), Buffer.alloc(0)]); expect(fail).not.toHaveBeenCalled();
});
for (const fault of ["magic", "version", "reserved", "sequence", "direction", "size", "hello-size"] as const)
  it("rejects header before accepting payload: " + fault, () => {
    const got = vi.fn(), fail = vi.fn(), reader = new NativeControlReader("to-main", got, fail);
    const header = encodeControlFrame({ kind: ControlKind.hello, body: Buffer.alloc(48) }, 1, "to-main").subarray(0, 16);
    if (fault === "magic") header[0]! |= 0x80;
    if (fault === "version") header[4] = 2;
    if (fault === "reserved") header[6] = 1;
    if (fault === "sequence") header.writeUInt32LE(2, 12);
    if (fault === "direction") header[5] = ControlKind.accept;
    if (fault === "size") { header[5] = ControlKind.request; header.writeUInt32LE(0xffffffff, 8); }
    if (fault === "hello-size") header.writeUInt32LE(47, 8);
    reader.write(header); reader.write(Buffer.alloc(48)); expect(fail).toHaveBeenCalledTimes(1); expect(got).not.toHaveBeenCalled();
  });
it("rejects worker TMCP bytes as control even with valid lengths and sequence", () => {
  const fail = vi.fn(), reader = new NativeControlReader("to-main", vi.fn(), fail);
  const frame = encodeControlFrame({ kind: ControlKind.clean, body: Buffer.alloc(0) }, 1, "to-main");
  frame.write("TMCP"); reader.write(frame); expect(fail).toHaveBeenCalledTimes(1);
});
it("has a fixed partial-frame deadline that trickles cannot extend", async () => {
  vi.useFakeTimers(); const fail = vi.fn(), reader = new NativeControlReader("to-main", vi.fn(), fail);
  reader.write(Buffer.from("T")); await vi.advanceTimersByTimeAsync(1500); reader.write(Buffer.from("M"));
  await vi.advanceTimersByTimeAsync(500); expect(fail).toHaveBeenCalledTimes(1); reader.stop();
});
it("rejects truncated input and empty request data", () => {
  const fail = vi.fn(), reader = new NativeControlReader("to-main", vi.fn(), fail);
  reader.write(Buffer.from("TM")); reader.end(); expect(fail).toHaveBeenCalledTimes(1);
  expect(() => encodeControlFrame({ kind: ControlKind.request, body: Buffer.alloc(0) }, 1, "to-main")).toThrow();
});
it("accepts exact request/response bounds and rejects one additional byte", () => {
  for (const [kind, direction, size] of [[ControlKind.request, "to-main", NativeControl.requestBytes],
    [ControlKind.response, "from-main", NativeControl.responseBytes]] as const) {
    const received = vi.fn(), fail = vi.fn(), reader = new NativeControlReader(direction, received, fail);
    reader.write(encodeControlFrame({ kind, body: Buffer.alloc(size) }, 1, direction)); reader.end();
    expect(received).toHaveBeenCalledTimes(1); expect(fail).not.toHaveBeenCalled();
    expect(() => encodeControlFrame({ kind, body: Buffer.alloc(size + 1) }, 1, direction)).toThrow();
  }
});
