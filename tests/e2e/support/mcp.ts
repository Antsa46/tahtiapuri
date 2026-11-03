import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { join } from "node:path";
import { isDevelopmentResult, type DevelopmentResult } from "@tahtiapuri/validation/development";
export async function connectMcp(data: string) {
  const root = process.cwd();
  const client = new Client({ name: "tahtiapuri-test-client", version: "0.0.1" });
  const env: Record<string, string> = {};
  for (const k of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) if (process.env[k]) env[k] = process.env[k]!;
  const transport = new StdioClientTransport({
    command: join(root, ".local/toolchain/node-v24.22.2-win-x64/node.exe"),
    args: [join(root, ".artifacts/tests/e2e-build/mcp-server.js"), join(data, "mcp/connection.json")],
    cwd: root, env, stderr: "pipe", maxBufferSize: 262_144,
  });
  await client.connect(transport);
  return { client, transport, async call(name: string, args: Record<string, unknown> = {}): Promise<DevelopmentResult> {
    const r = await client.callTool({ name, arguments: args });
    if (!isDevelopmentResult(r.structuredContent)) throw new Error("Unexpected MCP result.");
    return r.structuredContent;
  } };
}
