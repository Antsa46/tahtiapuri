import { expect, it, vi } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { encodeMuxFrame, McpMuxReader, MuxKind, type MuxFrame } from "./mcp-mux-wire.js";
import { startMcpMuxWorker } from "./mcp-mux-worker.js";

const denied = { ok: false, code: "INVALID_INPUT" };
interface RpcReply { id: number; result?: { tools?: { name: string }[]; structuredContent?: unknown }; error?: unknown }
function fixture() {
  const input = new PassThrough(), output = new PassThrough();
  const frames: MuxFrame[] = [], commands: { id: string; operation: string; input: unknown }[] = [];
  const replies = new Map<number, (value: RpcReply) => void>();
  let sequence = 1, id = 0, remainder = "", resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const write = (kind: MuxFrame["kind"], body: Buffer, fragmented = false) => {
    const bytes = encodeMuxFrame({ kind, body }, sequence++, "to-worker");
    if (fragmented) for (const byte of bytes) input.write(Buffer.from([byte]));
    else input.write(bytes);
  };
  const errors: Error[] = [];
  const reader = new McpMuxReader("from-worker", frame => {
    frames.push(frame);
    if (frame.kind === MuxKind.ready) { resolveReady(); return; }
    if (frame.kind === MuxKind.development) {
      const command = JSON.parse(frame.body.toString()) as { id: string; operation: string; input: unknown };
      commands.push(command);
      write(MuxKind.development, Buffer.from(JSON.stringify({ id: command.id, result: denied }) + "\n"), true);
      return;
    }
    remainder += frame.body.toString();
    let end: number;
    while ((end = remainder.indexOf("\n")) >= 0) {
      const reply = JSON.parse(remainder.slice(0, end)) as RpcReply; remainder = remainder.slice(end + 1);
      replies.get(reply.id)?.(reply); replies.delete(reply.id);
    }
  }, error => errors.push(error));
  output.on("data", (chunk: Buffer) => reader.write(chunk));
  const handle = startMcpMuxWorker(input, output);
  const call = (method: string, params?: unknown) => new Promise<RpcReply>(resolve => {
    const requestId = ++id; replies.set(requestId, resolve);
    write(MuxKind.mcp, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, ...(params === undefined ? {} : { params }) }) + "\n"), true);
  });
  const initialize = async () => {
    await ready;
    expect((await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic-mux-client", version: "0.0.1" } })).error).toBeUndefined();
    write(MuxKind.mcp, Buffer.from('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'));
  };
  const close = async () => { await handle.close(); await handle.finished; reader.stop(); input.destroy(); output.destroy(); };
  return { input, output, ready, frames, commands, reader, errors, handle, write, call, initialize, close };
}
it("carries real SDK initialization, tools and development traffic over two fragmented channels", async () => {
  const f = fixture();
  try {
    await f.initialize();
    expect(f.frames[0]?.kind).toBe(MuxKind.ready);
    expect(f.frames.filter(frame => frame.kind === MuxKind.ready)).toHaveLength(1);
    expect((await f.call("tools/list")).result?.tools?.map(tool => tool.name).sort()).toEqual(["cancel_probe", "model_probe", "model_status"]);
    expect((await f.call("tools/call", { name: "model_status", arguments: {} })).result?.structuredContent).toEqual(denied);
    expect(f.commands).toMatchObject([{ operation: "status", input: null }]);
    for (let n = 0; n < 20; n++) expect((await f.call("ping")).error).toBeUndefined();
    f.write(MuxKind.close, Buffer.alloc(0)); f.input.end();
    expect(await f.handle.finished).toBe("closed");
    expect(f.output.writableFinished).toBe(true); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
it("preserves discovery fallback over the mux and carries cancel_probe without closing", async () => {
  const f = fixture();
  try {
    await f.ready;
    expect((await f.call("server/discover", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } })).error).toBeUndefined();
    await f.initialize();
    expect((await f.call("tools/call", { name: "cancel_probe", arguments: { jobId: "00000000-0000-4000-8000-000000000001" } })).result?.structuredContent).toEqual(denied);
    expect((await f.call("ping")).error).toBeUndefined(); expect(f.commands[0]?.operation).toBe("cancel");
  } finally { await f.close(); }
});
it.each(["eof", "truncated", "invalid-kind", "rpc-cancel"])("fails the worker protocol on %s", async cause => {
  const f = fixture();
  try {
    await f.initialize();
    if (cause === "eof") f.input.end();
    if (cause === "truncated") f.input.end(Buffer.from("TMCP"));
    if (cause === "invalid-kind") { const bytes = Buffer.alloc(16); bytes.write("TMCP"); bytes[4] = 1; bytes[5] = 255; f.input.write(bytes); }
    if (cause === "rpc-cancel") f.write(MuxKind.mcp, Buffer.from('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}\n'));
    expect(await f.handle.finished).toBe("failed"); expect(f.input.destroyed).toBe(true);
  } finally { await f.close(); }
});
it("does not admit a ninth pending SDK request from a single coalesced mux input", async () => {
  const f = fixture();
  try {
    await f.ready;
    const request = (id: number) => Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "ping" }) + "\n");
    f.input.write(Buffer.concat(Array.from({ length: 9 }, (_, n) => encodeMuxFrame({ kind: MuxKind.mcp, body: request(n) }, n + 1, "to-worker"))));
    expect(await f.handle.finished).toBe("failed");
    expect(f.commands).toHaveLength(0);
  } finally { await f.close(); }
});
it("fails if the physical writer cannot finish a normal close", async () => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, done) { done(); }, final(done) { setImmediate(() => done(new Error("synthetic final error"))); } });
  const handle = startMcpMuxWorker(input, output);
  await handle.close(); expect(await handle.finished).toBe("failed");
  expect(output.destroyed).toBe(true); expect(input.destroyed).toBe(true);
});
it("bounds READY backpressure even before any client request", async () => {
  vi.useFakeTimers();
  const input = new PassThrough(), output = new Writable({ write() {} });
  const handle = startMcpMuxWorker(input, output);
  try {
    await vi.advanceTimersByTimeAsync(2000);
    expect(await handle.finished).toBe("failed"); expect(output.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { await handle.close(); vi.useRealTimers(); }
});

it.each([false, true])("closes during two pending development calls with physical failure=%s", async fails => {
  const input = new PassThrough();
  let sequence = 1, stall = false, complete!: (error?: Error | null) => void, developmentStarted!: () => void;
  const waiting = new Promise<void>(resolve => { developmentStarted = resolve; });
  const frames: MuxFrame[] = [];
  let initialized!: () => void;
  const initialization = new Promise<void>(resolve => { initialized = resolve; });
  const reader = new McpMuxReader("from-worker", frame => {
    frames.push(frame);
    if (frame.kind === MuxKind.mcp) initialized();
  }, error => { throw error; });
  const output = new Writable({ highWaterMark: 1, write(bytes, _encoding, done) {
    reader.write(bytes);
    if (stall) { complete = done; developmentStarted(); } else done();
  } });
  const handle = startMcpMuxWorker(input, output);
  const send = (kind: MuxFrame["kind"], body: Buffer) => input.write(encodeMuxFrame({ kind, body }, sequence++, "to-worker"));
  try {
    send(MuxKind.mcp, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic-close", version: "0.0.1" } } }) + "\n"));
    await initialization; await new Promise(resolve => setImmediate(resolve));
    send(MuxKind.mcp, Buffer.from('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'));
    stall = true;
    for (const id of [2, 3]) send(MuxKind.mcp, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "model_status", arguments: {} } }) + "\n"));
    await waiting; await new Promise(resolve => setImmediate(resolve));
    send(MuxKind.close, Buffer.alloc(0)); input.end();
    // Closing must first destroy virtual channels; then only physically admitted
    // bytes may drain. The second DEV write must never reach the owner.
    await new Promise(resolve => setImmediate(resolve));
    complete(fails ? new Error("synthetic held write error") : undefined);
    expect(await handle.finished).toBe(fails ? "failed" : "closed");
    expect(frames.filter(frame => frame.kind === MuxKind.development)).toHaveLength(1);
    expect(frames.filter(frame => frame.kind === MuxKind.mcp)).toHaveLength(1);
  } finally { await handle.close(); reader.stop(); }
});
