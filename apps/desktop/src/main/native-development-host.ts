import { createServer, type Server, type Socket } from "node:net";
import { mkdir, opendir } from "node:fs/promises";
import { join, win32 } from "node:path";
import { randomBytes } from "node:crypto";
import type { DevelopmentResult } from "@tahtiapuri/validation/development";
import type { BackendController } from "./backend-controller.js";
import { securePrivateDirectory } from "./private-directory.js";
import { claimDevelopmentBackend } from "./development-owner.js";
import { NativeDevelopmentAdmission } from "./native-development-admission.js";
import { encodeNativeBootstrap, NATIVE_PIPE_PREFIX } from "./native-development-bootstrap.js";
import { NativeMainConnection, type NativeConnectionOutcome } from "./native-main-connection.js";
import type { NativeMcpHostResources } from "./native-mcp-resources.js";

export interface NativeHostOutcome {
  readonly descriptorRemoved: boolean;
  readonly helperExitVerified: boolean;
  readonly backendRevoked: boolean;
  readonly listenerClosed: boolean;
  readonly brokerCleanupReported: boolean;
  readonly reservationCreated: boolean;
  readonly reservationReleased: false;
  readonly failed: boolean;
}
type Backend = Pick<BackendController, "development">;
const unavailable = (): DevelopmentResult => ({ ok: false, code: "ENGINE_UNAVAILABLE" });
/** One-shot host. The fixed persistent reservation is NEVER removed here, even
 * after CLEAN. Reopening needs the future independently verified broker recovery.
 * Caller owns the Electron single-instance lock and fixed private directory. */
export class NativeDevelopmentHost {
  private attempted = false;
  private closing = false;
  private accepting = false;
  private opening: Promise<void> | undefined;
  private stopping: Promise<NativeHostOutcome> | undefined;
  private server: Server | undefined;
  private listening: Promise<void> | undefined;
  private configuration: Promise<DevelopmentResult> | undefined;
  private admission: NativeDevelopmentAdmission | undefined;
  private descriptor: Buffer | undefined;
  private descriptorState: "unexamined" | "absent" | "publishing" | "published" | "consuming" | "removed" | "uncertain" = "unexamined";
  private descriptorWork: Promise<void> | undefined;
  private readonly abort = new AbortController();
  private readonly cleanupAbort = new AbortController();
  private readonly connections = new Map<Socket, NativeMainConnection>();
  private readonly outcomes: NativeConnectionOutcome[] = [];
  private reservationCreated = false;
  private epochConfigured = false;
  private revocation: Promise<boolean> | undefined;
  private helpersSettled = true;
  private failed = false;
  private accepted = 0;
  private bucket = Date.now();
  private readonly file: string;

  constructor(private readonly backend: Backend, private readonly directory: string, private readonly resources: NativeMcpHostResources) {
    if (process.platform !== "win32" || !/^[A-Z]:\\/.test(directory) || win32.normalize(directory) !== directory
      || directory.length > 200 || directory === win32.parse(directory).root) throw new Error("Invalid native development directory.");
    if (typeof resources?.prepareWorker !== "function") throw new Error("Missing native MCP worker preparation.");
    claimDevelopmentBackend(backend);
    this.file = join(directory, "main-bootstrap.bin");
  }
  getStatus(): Promise<DevelopmentResult> { return this.backend.development("development.status"); }
  setEnabled(enabled: boolean): Promise<DevelopmentResult> {
    if (!enabled) {
      if (!this.attempted && !this.closing) return this.getStatus();
      return this.stop().then(result => result.failed ? unavailable() : this.getStatus());
    }
    if (this.attempted || this.closing) return Promise.resolve(unavailable());
    this.attempted = true;
    this.opening = this.open();
    return this.opening.then(() => this.closing ? unavailable() : this.getStatus(), async () => {
      if (!this.closing) this.failed = true; await this.stop(); return unavailable();
    });
  }
  stop(): Promise<NativeHostOutcome> {
    if (this.stopping) return this.stopping;
    // Publish the shared promise before abort listeners or connection callbacks
    // can synchronously re-enter stop().
    let resolveStop!: (outcome: NativeHostOutcome) => void;
    this.stopping = new Promise(resolve => { resolveStop = resolve; });
    this.closing = true; this.accepting = false; this.abort.abort();
    void this.admission?.disable();
    for (const connection of this.connections.values()) void connection.stop();
    void this.bound(this.close(), 30000).then(result => {
      if (!result) this.cleanupAbort.abort();
      resolveStop(result ?? Object.freeze({
      descriptorRemoved: false, helperExitVerified: false, backendRevoked: false, listenerClosed: false,
      brokerCleanupReported: false, reservationCreated: this.reservationCreated, reservationReleased: false, failed: true,
    }));
    });
    return this.stopping;
  }
  private alive() { if (this.closing) throw new Error("Native development opening cancelled."); }
  private async helper<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error && typeof error === "object" && "exitVerified" in error && error.exitVerified === false) this.helpersSettled = false;
      throw error;
    }
  }
  private async open(): Promise<void> {
    try {
      await this.helper(() => securePrivateDirectory(this.directory, this.abort.signal)); this.alive();
      // A fixed CREATE_NEW reservation survives crashes and every normal close.
      // An existing reservation is never repaired, deleted or bypassed.
      await mkdir(join(this.directory, "native-session-reserved")); this.reservationCreated = true; this.alive();
      const entries = await opendir(join(this.directory, "native-session-reserved"));
      try { if (await entries.read()) throw new Error("Native reservation is not empty."); } finally { await entries.close(); }
      await this.helper(() => this.resources.helpers.operate("recover", this.file, undefined, this.abort.signal));
      this.descriptorState = "absent"; this.alive();
      // The descriptor is an executable launch opportunity for an external MCP
      // client. Finish the fixed package before identity/configure/listen/publish.
      // Cancellation never abandons this tracked promise or removes partial data.
      await this.resources.prepareWorker(join(this.directory, "native-session-reserved"), this.abort.signal); this.alive();
      const main = await this.helper(() => this.resources.helpers.identity(this.abort.signal)); this.alive();
      const epoch = randomBytes(32).toString("hex"), pipeNonce = randomBytes(16).toString("hex");
      // A failed acknowledgement can still mean the backend changed; revoke it.
      this.configuration = Promise.resolve().then(() => {
        this.alive(); this.epochConfigured = true;
        return this.backend.development("development.configure", epoch);
      });
      const configured = await this.configuration; this.alive();
      if (!configured.ok || !("status" in configured) || !configured.status.enabled) throw new Error("Native backend unavailable.");
      this.admission = new NativeDevelopmentAdmission(this.backend, epoch);
      const ticket = this.admission.issueTicket();
      if (!ticket) throw new Error("Native admission unavailable.");
      this.descriptor = encodeNativeBootstrap({ main, pipeNonce, ticket });
      const server = createServer(socket => this.accept(socket));
      server.maxConnections = 4; this.server = server;
      server.on("error", () => { this.failed = true; void this.stop(); });
      this.listening = Promise.resolve().then(() => {
        this.alive();
        return new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(NATIVE_PIPE_PREFIX + pipeNonce, () => { server.removeListener("error", reject); resolve(); });
        });
      });
      await this.listening; this.alive();
      this.descriptorState = "publishing";
      this.descriptorWork = this.helper(() => this.resources.helpers.operate("publish", this.file, this.descriptor, this.abort.signal))
        .then(() => { this.descriptorState = "published"; }, error => { this.descriptorState = "uncertain"; throw error; });
      // The descriptor may become visible before the publisher exits. A claimed
      // connection must await publication settlement before consuming it.
      this.accepting = true;
      await this.descriptorWork; this.alive();
    } catch (error) { this.accepting = false; throw error; }
  }
  private accept(socket: Socket) {
    socket.on("error", () => {});
    if (!this.accepting || this.closing || !this.admission || this.connections.size >= 4) { socket.destroy(); return; }
    if (Date.now() - this.bucket >= 1000) { this.bucket = Date.now(); this.accepted = 0; }
    if (++this.accepted > 16) { socket.destroy(); this.failed = true; void this.stop(); return; }
    const connection = new NativeMainConnection(socket, this.admission, {
      consume: async (ticket, signal) => {
        await this.descriptorWork;
        signal.throwIfAborted();
        if (this.descriptorState !== "published" || !this.descriptor
          || this.descriptor.subarray(48, 64).toString("hex") !== ticket.generation
          || this.descriptor.subarray(64).toString("hex") !== ticket.token) throw new Error("Native descriptor mismatch.");
        this.descriptorState = "consuming";
        this.descriptorWork = this.helper(() => this.resources.helpers.operate("consume", this.file, this.descriptor, signal))
          .then(() => { this.descriptorState = "removed"; }, error => { this.descriptorState = "uncertain"; throw error; });
        await this.descriptorWork;
      },
      revoke: () => this.revoke(),
    });
    this.connections.set(socket, connection);
    void connection.closed.then(outcome => {
      this.connections.delete(socket);
      // Keep only the owning generation outcome, not an unbounded history of
      // rejected unauthenticated peers.
      if (outcome.authenticated || this.admission?.phase === "disabled") {
        this.outcomes.push(outcome); this.failed ||= outcome.failed; void this.stop();
      }
    });
  }
  private revoke(): Promise<boolean> {
    this.revocation ??= (async () => {
      await this.configuration?.catch(() => {});
      if (!this.epochConfigured) return true;
      const result = await this.backend.development("development.configure", null);
      return result.ok && "status" in result && !result.status.enabled && !result.status.connected;
    })().catch(() => false);
    return this.revocation;
  }
  private async close(): Promise<NativeHostOutcome> {
    this.accepting = false;
    // Listener and backend revocation must not wait behind descriptor I/O.
    // Their own in-flight creation is still awaited, so a late listen/configure
    // cannot restore a resource after its cleanup was reported.
    const server = this.server;
    const listener = !server ? Promise.resolve(true) : (async () => {
      await this.listening?.catch(() => {});
      return new Promise<boolean>(resolve => {
        try { server.close(error => resolve(!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING")); }
        catch { resolve(false); }
      });
    })();
    const connections = [...this.connections.values()];
    const stoppedWork = Promise.all(connections.map(connection => connection.stop()));
    const detachedWork = this.admission?.disable() ?? Promise.resolve(true);
    const revokedWork = detachedWork.then(() => this.revoke());
    await this.opening?.catch(() => {});
    const stopped = await stoppedWork;
    const detached = await detachedWork;
    const revoked = await revokedWork;
    await this.descriptorWork?.catch(() => {});
    if (!this.cleanupAbort.signal.aborted && this.helpersSettled && this.descriptorState === "published" && this.descriptor) {
      this.descriptorState = "consuming";
      try { await this.helper(() => this.resources.helpers.operate("consume", this.file, this.descriptor, this.cleanupAbort.signal)); this.descriptorState = "removed"; }
      catch { this.descriptorState = "uncertain"; }
    }
    const listenerClosed = await this.bound(listener, 3000) === true;
    const outcomes = [...this.outcomes, ...stopped];
    const brokerCleanupReported = outcomes.some(outcome => outcome.authenticated && outcome.brokerCleanupReported);
    const descriptorRemoved = this.descriptorState === "absent" || this.descriptorState === "removed";
    this.descriptor?.fill(0);
    return Object.freeze({ descriptorRemoved, helperExitVerified: this.helpersSettled, backendRevoked: revoked,
      listenerClosed, brokerCleanupReported, reservationCreated: this.reservationCreated, reservationReleased: false,
      failed: this.failed || !detached || !revoked || !listenerClosed || this.attempted && !descriptorRemoved || !this.helpersSettled
        || outcomes.some(outcome => outcome.failed) });
  }
  private bound<T>(work: Promise<T>, milliseconds: number): Promise<T | undefined> {
    return new Promise(resolve => {
      let settled = false;
      const finish = (value?: T) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => finish(), milliseconds);
      void work.then(finish, () => finish());
    });
  }
}
