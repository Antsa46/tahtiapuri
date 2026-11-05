import { readFrames, RESPONSE_FRAME_BYTES } from "@tahtiapuri/validation/development-framing";
import { createConnection, type Socket } from "node:net";
import { lstat, readFile } from "node:fs/promises";
import { exactKeys, isRecord } from "@tahtiapuri/validation/public";
import { isConnectionDescription, type BridgeCommand, type DevelopmentResult } from "@tahtiapuri/validation/development";
import { ConnectedDevelopmentClient, type DevelopmentRequests } from "./connected-development-client.js";

/** Ordinary desktop bootstrap; isolated callers import connected-development-client instead. */
export class DevelopmentClient implements DevelopmentRequests {
  private socket: Socket | undefined;
  private client: ConnectedDevelopmentClient | undefined;
  private closed = false;
  private connecting = false;
  async connect(descriptionFile: string): Promise<void> {
    if (this.closed || this.connecting || this.socket) return;
    this.connecting = true;
    try {
      const file = await lstat(descriptionFile);
      if (this.closed) return;
      if (!file.isFile() || file.isSymbolicLink() || file.size > 2048) { this.close(); return; }
      const description: unknown = JSON.parse(await readFile(descriptionFile, "utf8"));
      if (this.closed) return;
      if (!isConnectionDescription(description)) { this.close(); return; }
      const socket = createConnection(description.pipe);
      this.socket = socket;
      socket.setEncoding("utf8");
      let buffer = "";
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.close(); finish(); }, 3000);
        const finish = () => { clearTimeout(timer); resolve(); };
        const failed = () => { this.close(); finish(); };
        const authenticate = () => {
          try { socket.write(JSON.stringify({ token: description.token }) + "\n"); }
          catch { failed(); }
        };
        const receive = (chunk: string) => {
          try {
            const parsed = readFrames(buffer, chunk, RESPONSE_FRAME_BYTES);
            buffer = parsed.remainder;
            if (parsed.frames.length === 0) return;
            const message: unknown = JSON.parse(parsed.frames[0]!);
            if (!isRecord(message) || !exactKeys(message, ["connected"]) || message.connected !== true) throw new Error("Invalid development handshake.");
            socket.off("data", receive);
            // Transfer every trailing frame and partial frame before accepting requests.
            const trailing = parsed.frames.slice(1).map(line => line + "\n").join("") + buffer;
            this.client = new ConnectedDevelopmentClient(socket, trailing);
            socket.off("error", failed);
            socket.off("close", failed);
            socket.off("end", failed);
            socket.off("connect", authenticate);
            finish();
          } catch { failed(); }
        };
        socket.on("error", failed);
        socket.once("close", failed);
        socket.once("end", failed);
        socket.once("connect", authenticate);
        socket.on("data", receive);
      });
    } catch { this.close(); }
  }
  request(operation: BridgeCommand["operation"], input: unknown): Promise<DevelopmentResult> {
    return this.client?.request(operation, input) ?? Promise.resolve({ ok: false, code: "ENGINE_UNAVAILABLE" });
  }
  close(): void {
    this.closed = true;
    this.client?.close();
    this.socket?.destroy();
  }
}
