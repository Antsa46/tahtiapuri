import { readFrames, RESPONSE_FRAME_BYTES } from "@tahtiapuri/validation/development-framing";
import { createConnection, type Socket } from "node:net";
import { lstat, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { exactKeys, isRecord } from "@tahtiapuri/validation/public";
import { isConnectionDescription, isDevelopmentResult, type BridgeCommand, type DevelopmentResult } from "@tahtiapuri/validation/development";
const unavailable = (): DevelopmentResult => ({ ok: false, code: "ENGINE_UNAVAILABLE" });
export class DevelopmentClient {
  private socket: Socket | undefined;
  private connected = false;
  private pending = new Map<string, { resolve(value: DevelopmentResult): void; timer: NodeJS.Timeout }>();
  async connect(descriptionFile: string): Promise<void> {
    if (this.socket) return;
    try {
      const file = await lstat(descriptionFile);
      if (!file.isFile() || file.isSymbolicLink() || file.size > 2048) return;
      const description: unknown = JSON.parse(await readFile(descriptionFile, "utf8"));
      if (!isConnectionDescription(description)) return;
      const socket = createConnection(description.pipe);
      this.socket = socket;
      socket.setEncoding("utf8");
      let buffer = "";
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.close(); resolve(); }, 3000);
        const finish = () => { clearTimeout(timer); resolve(); };
        socket.on("error", () => { this.close(); finish(); });
        socket.on("close", () => { this.close(); finish(); });
        socket.once("connect", () => socket.write(JSON.stringify({ token: description.token }) + "\n"));
        socket.on("data", (chunk: string) => {
          let frames: string[];
          try { const parsed = readFrames(buffer, chunk, RESPONSE_FRAME_BYTES); buffer = parsed.remainder; frames = parsed.frames; }
          catch { this.close(); finish(); return; }
          for (const line of frames) {
            try {
              const message: unknown = JSON.parse(line);
              if (!this.connected) {
                if (!isRecord(message) || !exactKeys(message, ["connected"]) || message.connected !== true) throw new Error();
                this.connected = true; finish(); continue;
              }
              if (!isRecord(message) || !exactKeys(message, ["id", "result"]) || typeof message.id !== "string" || !isDevelopmentResult(message.result)) throw new Error();
              const pending = this.pending.get(message.id);
              if (!pending) continue;
              clearTimeout(pending.timer); this.pending.delete(message.id); pending.resolve(message.result);
            } catch { this.close(); finish(); }
          }
        });
      });
    } catch { this.close(); }
  }
  request(operation: BridgeCommand["operation"], input: unknown): Promise<DevelopmentResult> {
    if (!this.socket || !this.connected || this.socket.destroyed || this.pending.size >= 4) return Promise.resolve(unavailable());
    const id = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.close(); }, 5000);
      this.pending.set(id, { resolve, timer });
      this.socket!.write(JSON.stringify({ id, operation, input }) + "\n");
    });
  }
  close() {
    this.connected = false;
    this.socket?.destroy();
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.resolve(unavailable()); }
    this.pending.clear();
  }
}
