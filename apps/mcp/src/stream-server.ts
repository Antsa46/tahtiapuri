import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { Duplex, Readable, Writable } from "node:stream";
import { ConnectedDevelopmentClient } from "./connected-development-client.js";
import { createDevelopmentServer } from "./server-core.js";
import { BoundedMcpTransport } from "./bounded-mcp-transport.js";

// Owned inputs may emit a pending read/destroy error after SDK close removes
// its handlers. Keep a shared sink for the remaining lifetime of that stream.
const consumeLateInputError = () => {};

export interface McpStreams {
  input: Readable;
  output: Writable;
  /** Already authenticated by the trusted owner; owned and destroyed by this session. */
  development: Duplex;
  /** The SDK only pauses input. Choose explicitly who closes the injected MCP streams. */
  mcpStreamOwnership: "caller" | "server";
}

/** Separate candidate entry: no descriptor, named pipe, path, or process-global stdio. */
export function startMcpStreams(streams: McpStreams): StdioServerHandle {
  const client = new ConnectedDevelopmentClient(streams.development);
  let handle: StdioServerHandle | undefined;
  let closing: Promise<void> | undefined;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    client.onclose = undefined;
    client.close();
    if (streams.mcpStreamOwnership === "server") streams.input.on("error", consumeLateInputError);
    streams.input.off("end", stop);
    streams.input.off("close", stop);
    streams.input.off("error", stop);
    streams.output.off("close", stop);
    streams.output.off("error", stop);
    if (streams.mcpStreamOwnership === "server") {
      streams.input.destroy();
      streams.output.destroy();
    }
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    // Publish the close promise before client.close can re-enter via SDK callbacks.
    closing = Promise.resolve().then(async () => { await handle?.close(); });
    release();
    return closing;
  };
  const stop = () => { void close(); };
  streams.input.once("end", stop);
  streams.input.once("close", stop);
  streams.input.on("error", stop);
  streams.output.once("close", stop);
  streams.output.on("error", stop);
  client.onclose = stop;
  const transport = new BoundedMcpTransport(streams.input, streams.output, release);
  try {
    handle = serveStdio(() => createDevelopmentServer(client, { ownsClient: false }), { transport, maxSubscriptions: 0 });
  } catch (error) {
    release();
    throw error;
  }
  if (client.isClosed || streams.input.destroyed || streams.input.readableEnded || streams.output.destroyed || streams.output.writableEnded) stop();
  return { close };
}
