import { expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { McpMuxChannel } from "./mcp-mux-channel.js";
import { MCP_MUX, MuxKind } from "./mcp-mux-wire.js";
import { McpMuxWriter } from "./mcp-mux-writer.js";
function fixture(kind: typeof MuxKind.mcp | typeof MuxKind.development = MuxKind.development) {
  const write = vi.fn(), fail = vi.fn();
  const channel = new McpMuxChannel(kind, { write } as unknown as McpMuxWriter, fail);
  return { channel, write, fail };
}
it("caps a paused readable even when its consumer switches to text decoding", () => {
  const f = fixture();
  try {
    f.channel.setEncoding("utf8");
    f.channel.receive(Buffer.alloc(16_384, 97));
    expect(f.channel.readableLength).toBe(16_384);
    f.channel.receive(Buffer.from("x")); expect(f.fail).toHaveBeenCalledTimes(1);
  } finally { f.channel.destroy(); }
});
it("copies retained input and does not accept excess binary channel bytes", () => {
  const f = fixture(MuxKind.mcp), bytes = Buffer.alloc(MCP_MUX.mcpInputBytes, 97);
  try {
    f.channel.receive(bytes); bytes.fill(0); f.channel.receive(Buffer.from("x"));
    expect(f.fail).toHaveBeenCalledTimes(1); expect(f.channel.read()).toEqual(Buffer.alloc(MCP_MUX.mcpInputBytes, 97));
  } finally { f.channel.destroy(); }
});
it("caps queued virtual writes before Node can retain more frames", async () => {
  const f = fixture(), callbacks = Array.from({ length: 17 }, () => vi.fn());
  for (const callback of callbacks) f.channel.write("x", callback);
  expect(f.write).toHaveBeenCalledTimes(1); expect(f.fail).toHaveBeenCalledTimes(1);
  expect(callbacks[16]).toHaveBeenCalledWith(expect.any(Error));
  f.channel.destroy();
  const done = f.write.mock.calls[0]![1] as (error?: Error) => void; done(new Error("synthetic close"));
  await new Promise(resolve => setImmediate(resolve));
  expect(callbacks.every(callback => callback.mock.calls.length === 1)).toBe(true);
});
it("copies pending output and releases its callback once on physical completion", async () => {
  const f = fixture(), bytes = Buffer.from("original"), callback = vi.fn();
  try {
    f.channel.write(bytes, callback); bytes.fill(0);
    expect(f.write.mock.calls[0]![0].body.toString()).toBe("original");
    expect(callback).not.toHaveBeenCalled();
    f.write.mock.calls[0]![1](); await new Promise(resolve => setImmediate(resolve));
    expect(callback).toHaveBeenCalledTimes(1);
  } finally { f.channel.destroy(); }
});

it("bounds a paused UTF-8 decoder's incomplete sequence with three bytes of explicit slack", () => {
  const f = fixture();
  try {
    f.channel.setEncoding("utf8");
    f.channel.receive(Buffer.from([0xf0, 0x9f, 0x8c]));
    expect(f.channel.readableLength).toBe(0);
    f.channel.receive(Buffer.alloc(MCP_MUX.developmentInputBytes, 97));
    expect(f.fail).not.toHaveBeenCalled();
    f.channel.receive(Buffer.from("x")); expect(f.fail).toHaveBeenCalledTimes(1);
    expect(Buffer.byteLength(f.channel.read() as string)).toBe(MCP_MUX.developmentInputBytes + 3);
  } finally { f.channel.destroy(); }
});
it.each([false, true])("settles virtual-only queued work once while the physical close drain fails=%s", async fails => {
  let complete!: (error?: Error | null) => void;
  const emitted: Buffer[] = [];
  const output = new Writable({ highWaterMark: 1, write(bytes, _encoding, done) { emitted.push(Buffer.from(bytes)); complete = done; } });
  const physicalFail = vi.fn(), channelFail = vi.fn();
  const writer = new McpMuxWriter(output, physicalFail);
  const channel = new McpMuxChannel(MuxKind.development, writer, channelFail);
  const first = vi.fn(), second = vi.fn();
  channel.write("first", first); channel.write("virtual-only", second);
  expect(emitted).toHaveLength(1); expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled();
  channel.destroy();
  const finished = writer.finish();
  const outcome = finished.then(() => "closed", () => "failed");
  complete(fails ? new Error("synthetic physical drain error") : undefined);
  expect(await outcome).toBe(fails ? "failed" : "closed");
  await new Promise(resolve => setImmediate(resolve));
  expect(emitted).toHaveLength(1); expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
  expect(physicalFail).toHaveBeenCalledTimes(fails ? 1 : 0);
});
