import type { Readable, Writable } from "node:stream";
import { McpMuxChannel } from "./mcp-mux-channel.js";
import { McpMuxReader, MuxKind } from "./mcp-mux-wire.js";
import { McpMuxWriter } from "./mcp-mux-writer.js";
import { startMcpStreams } from "./stream-server.js";

export interface McpWorkerHandle {
  /** Protocol completion only, never proof of process exit or OS cleanup. */
  finished: Promise<"closed" | "failed">;
  close(): Promise<void>;
}
/** Worker-side composition only. The trusted broker supplies authenticated DEV bytes. */
export function startMcpMuxWorker(input: Readable, output: Writable): McpWorkerHandle {
  let ready = false, stopping = false, failed = false;
  let closing: Promise<void> | undefined;
  let settle!: (outcome: "closed" | "failed") => void;
  const finished = new Promise<"closed" | "failed">(resolve => { settle = resolve; });
  let handle: ReturnType<typeof startMcpStreams> | undefined;
  const fail = (error: Error) => { failed = true; writer.abort(error); void close(); };
  const writer = new McpMuxWriter(output, error => { failed = true; void error; void close(); });
  const channelFailed = (error: Error) => { if (!stopping) fail(error); };
  const mcp = new McpMuxChannel(MuxKind.mcp, writer, channelFailed);
  const development = new McpMuxChannel(MuxKind.development, writer, channelFailed);
  const reader = new McpMuxReader("to-worker", frame => {
    if (stopping) return;
    if (!ready) { fail(new Error("MCP mux traffic before readiness.")); return; }
    if (frame.kind === MuxKind.close) { void close(); return; }
    if (frame.kind === MuxKind.mcp) mcp.receive(frame.body);
    else development.receive(frame.body);
  }, fail);
  const receive = (chunk: Buffer) => reader.write(chunk);
  const inputEnded = () => { reader.end(); fail(new Error("MCP mux owner disconnected.")); };
  const inputFailed = () => { if (!stopping) fail(new Error("MCP mux input failed.")); };
  const channelClosed = () => { if (!stopping) fail(new Error("MCP mux channel closed.")); };
  mcp.once("close", channelClosed); development.once("close", channelClosed);
  // The closure is assigned before any streams can synchronously invoke it.
  function close(): Promise<void> {
    if (closing) return closing;
    stopping = true;
    closing = Promise.resolve().then(async () => {
      try {
        await handle?.close();
        mcp.destroy(); development.destroy();
        if (!failed) await writer.finish();
      } catch { failed = true; writer.abort(new Error("MCP mux shutdown failed.")); }
      finally { input.destroy(); settle(failed ? "failed" : "closed"); }
    });
    reader.stop();
    input.off("data", receive); input.off("end", inputEnded); input.off("close", inputEnded);
    input.pause();
    return closing;
  }
  input.on("error", inputFailed); input.once("end", inputEnded); input.once("close", inputEnded);
  input.on("data", receive);
  try {
    handle = startMcpStreams({ input: mcp, output: mcp, development, mcpStreamOwnership: "server" });
    if (input.destroyed || input.readableEnded || output.destroyed || output.writableEnded) throw new Error("MCP mux stream unavailable.");
    // Both channels and all error handlers exist before the READY bytes are
    // issued. A peer may respond before the READY write callback completes.
    ready = true;
    writer.write({ kind: MuxKind.ready, body: Buffer.alloc(0) }, error => { if (error) fail(error); });
  } catch (error) { fail(error instanceof Error ? error : new Error("MCP mux startup failed.")); }
  return { finished, close };
}
