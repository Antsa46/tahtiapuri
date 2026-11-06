import { claimDevelopmentBackend } from "./development-owner.js";
import { readFrames, REQUEST_FRAME_BYTES } from "@tahtiapuri/validation/development-framing";
import { writeDevelopmentFrame } from "./development-socket.js";
import { createServer, type Server, type Socket } from "node:net";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord, exactKeys } from "@tahtiapuri/validation/public";
import { isBridgeCommand, isCapability, PIPE_PREFIX, type DevelopmentResult } from "@tahtiapuri/validation/development";
import type { BackendController } from "./backend-controller.js";
import { secureDevelopmentDirectory } from "./private-development-directory.js";
export class DevelopmentHost {
  private epoch: string | null = null;
  private accepting = false;
  private closed = false;
  private revision = 0;
  private transition: Promise<DevelopmentResult> | undefined;
  private deferredDisable: Promise<DevelopmentResult> | undefined;
  private stopPromise: Promise<void> | undefined;
  private server: Server | undefined;
  private sockets = new Set<Socket>();
  private clientId: string | null = null;
  private readonly description: string;
  constructor(private readonly backend: Pick<BackendController, "development">, private readonly directory: string) {
    claimDevelopmentBackend(backend);
    this.description = join(directory, "connection.json");
  }
  getStatus() { return this.backend.development("development.status"); }
  setEnabled(enabled: boolean): Promise<DevelopmentResult> {
    if (enabled && (this.closed || this.transition || this.deferredDisable))
      return Promise.resolve({ ok: false, code: this.closed ? "ENGINE_UNAVAILABLE" : "BUSY" });
    if (!enabled) { this.accepting = false; ++this.revision; }
    if (this.deferredDisable) return this.deferredDisable;
    if (this.transition) {
      const deferred = this.transition.catch(() => undefined).then(() => {
        this.deferredDisable = undefined;
        return this.setEnabled(false);
      });
      this.deferredDisable = deferred;
      return deferred;
    }
    const revision = ++this.revision;
    this.accepting = false;
    const operation = (async () => {
      await this.closeSession();
      if (enabled && revision === this.revision && !this.closed) {
        try {
          await secureDevelopmentDirectory(this.directory);
          if (revision !== this.revision || this.closed) return this.getStatus();
          try {
            const file = await lstat(this.description);
            if (!file.isFile() || file.isSymbolicLink()) throw new Error("Invalid connection description.");
            await unlink(this.description);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          const epoch = randomBytes(32).toString("hex");
          const pipe = PIPE_PREFIX + randomBytes(16).toString("hex");
          const server = createServer(socket => this.accept(socket, epoch));
          this.server = server;
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(pipe, () => { server.removeListener("error", reject); resolve(); });
          });
          server.on("error", () => { this.accepting = false; void this.setEnabled(false).catch(() => {}); });
          this.epoch = epoch;
          const response = await this.backend.development("development.configure", epoch);
          if (!response.ok) throw new Error("Development unavailable.");
          if (revision === this.revision && !this.closed) {
            await writeFile(this.description, JSON.stringify({ protocol: 1, pipe, token: epoch }), { flag: "wx", mode: 0o600 });
            if (revision === this.revision && !this.closed && this.epoch === epoch) this.accepting = true;
            else await this.closeSession();
          } else await this.closeSession();
        } catch {
          await this.closeSession();
          throw new Error("Development connection could not be opened.");
        }
      }
      return this.getStatus();
    })();
    this.transition = operation;
    void operation.finally(() => { if (this.transition === operation) this.transition = undefined; }).catch(() => {});
    return operation;
  }
  stop(): Promise<void> {
    this.closed = true;
    this.stopPromise ??= this.setEnabled(false).then(() => {});
    return this.stopPromise;
  }
  private async closeSession() {
    this.accepting = false;
    const owned = this.epoch;
    this.epoch = null;
    // The backend revokes rights and owned jobs before the transport is closed.
    try { await this.backend.development("development.configure", null); }
    finally {
      this.clientId = null;
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      const server = this.server; this.server = undefined;
      if (server) await new Promise<void>(resolve => server.close(() => resolve()));
      if (owned) {
        try {
          const file = await lstat(this.description);
          if (!file.isFile() || file.isSymbolicLink() || file.size > 2048) throw new Error("Invalid connection description.");
          const value: unknown = JSON.parse(await readFile(this.description, "utf8"));
          if (isRecord(value) && value.token === owned) await unlink(this.description);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
  }
  private accept(socket: Socket, epoch: string) {
    if (!this.accepting || this.epoch !== epoch || this.sockets.size >= 4) { socket.destroy(); return; }
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(3000, () => socket.destroy());
    let buffer = "", clientId: string | null = null, pending = 0, calls = 0, bucket = Date.now();
    const ids = new Set<string>();
    let work: Promise<void> = Promise.resolve();
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      this.sockets.delete(socket);
      if (clientId) {
        if (this.clientId === clientId) this.clientId = null;
        void this.backend.development("development.detach", { epoch, clientId }).catch(() => {});
      }
    });
    socket.on("data", (data: string) => {
      let frames: string[];
      try { const parsed = readFrames(buffer, data, REQUEST_FRAME_BYTES); buffer = parsed.remainder; frames = parsed.frames; }
      catch { socket.destroy(); return; }
      for (const line of frames) {
        if (++pending > 4) { socket.destroy(); return; }
        work = work.then(async () => {
          if (socket.destroyed || !this.accepting || this.epoch !== epoch) { socket.destroy(); return; }
          if (Date.now() - bucket > 1000) { bucket = Date.now(); calls = 0; }
          if (++calls > 60) { socket.destroy(); return; }
          const message: unknown = JSON.parse(line);
          if (!clientId) {
            if (!isRecord(message) || !exactKeys(message, ["token"]) || !isCapability(message.token)
              || !timingSafeEqual(Buffer.from(message.token, "hex"), Buffer.from(epoch, "hex")) || this.clientId) { socket.destroy(); return; }
            clientId = randomUUID();
            this.clientId = clientId;
            const result = await this.backend.development("development.attach", { epoch, clientId });
            if (!result.ok || socket.destroyed || !this.accepting || this.epoch !== epoch) { socket.destroy(); return; }
            socket.setTimeout(0);
            await writeDevelopmentFrame(socket, { connected: true });
            return;
          }
          if (!isBridgeCommand(message) || ids.has(message.id)) { socket.destroy(); return; }
          ids.add(message.id); if (ids.size > 256) ids.delete(ids.values().next().value!);
          const result = await this.backend.development("development.invoke", { epoch, clientId, operation: message.operation, input: message.input });
          if (!socket.destroyed && this.accepting && this.epoch === epoch && this.clientId === clientId)
            await writeDevelopmentFrame(socket, { id: message.id, result });
        }).catch(() => { socket.destroy(); }).finally(() => { pending--; });
      }
    });
  }
}
