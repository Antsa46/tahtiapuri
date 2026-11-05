import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { DevelopmentClient } from "./development-client.js";
import { createDevelopmentServer } from "./server-core.js";

export async function startMcp(descriptionFile: string) {
  const client = new DevelopmentClient();
  await client.connect(descriptionFile);
  const handle = serveStdio(() => createDevelopmentServer(client), {
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 16_384 }),
    maxSubscriptions: 0,
  });
  const stop = () => { client.close(); void handle.close(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdin.once("end", () => client.close());
  return handle;
}
