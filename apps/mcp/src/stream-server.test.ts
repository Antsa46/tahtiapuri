import { expect, it, vi } from "vitest";
import { Duplex, PassThrough, Readable } from "node:stream";
import { once } from "node:events";
import { startMcpStreams } from "./stream-server.js";

// The candidate must compose entirely from the supplied streams. Bootstrap and
// even a transient descriptor/socket access are forbidden in this test entry.
const forbidden = vi.hoisted(() => ({ descriptor: vi.fn(() => { throw new Error("Descriptor access forbidden."); }), socket: vi.fn(() => { throw new Error("Socket access forbidden."); }) }));
vi.mock("node:fs/promises", () => ({ lstat: forbidden.descriptor, readFile: forbidden.descriptor }));
vi.mock("node:net", () => ({ createConnection: forbidden.socket }));
const denied = { ok: false, code: "INVALID_INPUT" };
class DevelopmentStream extends Duplex {
  readonly commands: { id: string; operation: string; input: unknown }[] = [];
  override _read() {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    const command = JSON.parse(chunk.toString()) as { id: string; operation: string; input: unknown };
    this.commands.push(command); done();
    this.push(JSON.stringify({ id: command.id, result: denied }) + "\n");
  }
}
interface RpcReply {
  id: number;
  result?: { tools?: { name: string }[]; structuredContent?: unknown; content?: unknown[]; isError?: boolean };
  error?: unknown;
}
function fixture(ownership: "caller" | "server" = "server") {
  const input = new PassThrough(), output = new PassThrough(), development = new DevelopmentStream();
  const replies = new Map<number, (reply: RpcReply) => void>(); let remainder = "", id = 0;
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    remainder += chunk; let end: number;
    while ((end = remainder.indexOf("\n")) >= 0) {
      const value = JSON.parse(remainder.slice(0, end)) as RpcReply;
      remainder = remainder.slice(end + 1); replies.get(value.id)?.(value); replies.delete(value.id);
    }
  });
  const handle = startMcpStreams({ input, output, development, mcpStreamOwnership: ownership });
  const exchange = (method: string, params?: unknown) => new Promise<RpcReply>(resolve => {
    const requestId = ++id; replies.set(requestId, resolve);
    input.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, ...(params === undefined ? {} : { params }) }) + "\n");
  });
  const initialize = async () => {
    const reply = await exchange("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic-stream-test", version: "0.0.1" } });
    expect(reply.error).toBeUndefined();
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  };
  return { input, output, development, handle, exchange, initialize };
}
it("serves the fixed tools and preserves both result representations without bootstrap access", async () => {
  const f = fixture();
  try {
    await f.initialize();
    const listed = await f.exchange("tools/list");
    expect(listed.result?.tools?.map(tool => tool.name).sort()).toEqual(["cancel_probe", "model_probe", "model_status"]);
    const status = await f.exchange("tools/call", { name: "model_status", arguments: {} });
    expect(f.development.commands).toMatchObject([{ operation: "status", input: null }]);
    expect(status.result).toMatchObject({ structuredContent: denied, content: [{ type: "text", text: JSON.stringify(denied) }], isError: true });
    const malformed = await f.exchange("tools/call", { name: "model_probe", arguments: { prompt: "synthetic", backend: "cpu", command: "forbidden" } });
    expect(malformed.error !== undefined || malformed.result?.isError).toBe(true);
    expect(f.development.commands).toHaveLength(1);
    expect(forbidden.descriptor).not.toHaveBeenCalled(); expect(forbidden.socket).not.toHaveBeenCalled();
  } finally { await f.handle.close(); }
  expect(f.development.destroyed).toBe(true); expect(f.input.destroyed).toBe(true); expect(f.output.destroyed).toBe(true);
});
it("releases owned streams on EOF even before an MCP opening message", async () => {
  const f = fixture(); f.input.end(); f.input.resume();
  await new Promise<void>(resolve => f.input.once("end", resolve));
  expect(f.development.destroyed).toBe(true); expect(f.input.destroyed).toBe(true); expect(f.output.destroyed).toBe(true); await f.handle.close();
});
it("closes owned MCP streams when the authenticated development channel disappears", async () => {
  const f = fixture(); f.development.emit("end");
  expect(f.input.destroyed).toBe(true); expect(f.output.destroyed).toBe(true); await f.handle.close();
});
it("keeps caller-owned MCP streams usable when explicitly closed", async () => {
  const f = fixture("caller"); await Promise.all([f.handle.close(), f.handle.close()]);
  expect(f.development.destroyed).toBe(true); expect(f.input.destroyed).toBe(false); expect(f.output.destroyed).toBe(false);
  expect(f.input.listenerCount("error")).toBe(0);
  f.input.destroy(); f.output.destroy();
});
it("fails closed on an MCP input larger than 16 KiB before initialization", async () => {
  const f = fixture(); const released = once(f.development, "close");
  f.input.write("x".repeat(16_385)); await released;
  expect(f.development.destroyed).toBe(true); expect(f.input.destroyed).toBe(true); expect(f.output.destroyed).toBe(true); await f.handle.close();
});
it("closes the session on output failure and consumes late write errors", async () => {
  const f = fixture(); f.output.emit("error", new Error("synthetic write failure"));
  expect(f.development.destroyed).toBe(true); expect(f.input.destroyed).toBe(true);
  await f.handle.close();
  expect(() => f.output.emit("error", new Error("synthetic late failure"))).not.toThrow();
});
it("releases the authenticated channel on output close before initialization", async () => {
  const f = fixture(); f.output.emit("close");
  expect(f.development.destroyed).toBe(true); expect(f.input.destroyed).toBe(true); await f.handle.close();
});

it("consumes an owned Readable's deferred destroy error after SDK close removes its input handlers", async () => {
  let completeDestroy!: (error?: Error | null) => void;
  const input = new Readable({
    read() {},
    destroy(_error, done) { completeDestroy = done; },
  });
  const output = new PassThrough(), development = new DevelopmentStream();
  const handle = startMcpStreams({ input, output, development, mcpStreamOwnership: "server" });
  const closed = new Promise<void>(resolve => input.once("close", resolve));
  await handle.close();
  expect(input.destroyed).toBe(true); expect(input.listenerCount("error")).toBe(1);
  const lateError = new Error("synthetic deferred input destruction failure");
  completeDestroy(lateError);
  await closed;
  expect(input.errored).toBe(lateError); expect(development.destroyed).toBe(true); expect(output.destroyed).toBe(true);
});
