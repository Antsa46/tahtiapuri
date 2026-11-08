import { requireNativeOperationDeadline } from "./native-operation-deadline.js";
import { createServer, type Server, type Socket } from "node:net";
import { mkdir, opendir } from "node:fs/promises";
import { join, win32 } from "node:path";
import { randomBytes } from "node:crypto";
import type { DevelopmentResult } from "@tahtiapuri/validation/development";
import type { BackendController } from "./backend-controller.js";
import { claimDevelopmentBackend } from "./development-owner.js";
import { NativeDevelopmentAdmission } from "./native-development-admission.js";
import { encodeNativeBootstrap, NATIVE_PIPE_PREFIX } from "./native-development-bootstrap.js";
import { NativeMainConnection, type NativeConnectionOutcome } from "./native-main-connection.js";
import type { NativeLaunchMcpResources } from "./native-launch-mcp-resources.js";
import { NativeDevelopmentLoadCall } from "./native-development-load-call.js";
import type { ObservedNativeDevelopmentResourceLoader } from "./native-development-resource-loader.js";
import { NativeDevelopmentResourceCall } from "./native-development-resource-call.js";
import { assessNativeMcpRelease } from "./native-mcp-release-policy.js";

export interface NativeHostOutcome {
  readonly descriptorRemoved: boolean;
  readonly helperExitVerified: boolean;
  readonly originalResourceWorkSettled: boolean;
  readonly resourceOwnerHealthy: boolean;
  readonly backendRevoked: boolean;
  readonly listenerClosed: boolean;
  readonly brokerCleanupReported: boolean;
  readonly reservationCreated: boolean;
  readonly reservationReleased: boolean;
  readonly failed: boolean;
}
type Backend = Pick<BackendController, "development">;
export type NativeDevelopmentResources = Pick<NativeLaunchMcpResources,
  "controlFile" | "prepareDirectory" | "identity" | "bootstrap" | "session" | "prepareWorker" | "observeCall" | "status">;
/** Trusted composition/test seam. Production closes over one approved config;
 * no executable, argv, verifier or legacy-execution choice is an IPC input. */
export type NativeDevelopmentResourceLoader = ObservedNativeDevelopmentResourceLoader;
const unavailable = (): DevelopmentResult => ({ ok: false, code: "ENGINE_UNAVAILABLE" });
/** One-shot host. Fixed native release operations decide whether a pristine or
 * admitted-clean reservation may retire. Persistent ownership records remain.
 * Reopening needs the later generation/recovery protocol; a new Host or backend
 * alias is never a rearm mechanism. Caller owns the Electron lock. */
export class NativeDevelopmentHost {
  private attempted = false;
  private closing = false;
  private accepting = false;
  private opening: Promise<void> | undefined;
  private openingDeadline = 0;
  private openingResult: Promise<DevelopmentResult> | undefined;
  private loading: Promise<NativeDevelopmentResources> | undefined;
  private loadingCall: NativeDevelopmentLoadCall | undefined;
  private resources: NativeDevelopmentResources | undefined;
  private bindingValid = false;
  private readonly resourceCalls: NativeDevelopmentResourceCall<unknown>[] = [];
  private closingWork: Promise<NativeHostOutcome> | undefined;
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
  private sessionSealed = false;
  private cleanupDeadline = 0;
  private epochConfigured = false;
  private revocation: Promise<boolean> | undefined;
  private helpersSettled = true;
  private failed = false;
  private accepted = 0;
  private bucket = Date.now();
  private readonly file: string;

  constructor(private readonly backend: Backend, private readonly directory: string, private readonly loadResources: NativeDevelopmentResourceLoader) {
    if (process.platform !== "win32" || !/^[A-Z]:\\/.test(directory) || win32.normalize(directory) !== directory
      || directory.length > 200 || directory === win32.parse(directory).root) throw new Error("Invalid native development directory.");
    if (typeof loadResources !== "function" || typeof loadResources.observe !== "function") throw new Error("Missing bound native MCP resource loader.");
    claimDevelopmentBackend(backend);
    this.file = join(directory, "main-bootstrap.bin");
  }
  getStatus(): Promise<DevelopmentResult> { return this.backend.development("development.status"); }
  setEnabled(enabled: false): Promise<DevelopmentResult>;
  setEnabled(enabled: true, openingDeadline: number): Promise<DevelopmentResult>;
  setEnabled(enabled: boolean, openingDeadline?: number): Promise<DevelopmentResult> {
    if (!enabled) {
      if (!this.attempted && !this.closing) return this.getStatus();
      return this.stop().then(result => result.failed ? unavailable() : this.getStatus());
    }
    if (this.attempted || this.closing) return Promise.resolve(unavailable());
    this.attempted = true;
    if (typeof openingDeadline !== "number" || !Number.isFinite(openingDeadline) || openingDeadline <= performance.now()) {
      this.failed = true; void this.stop(); return Promise.resolve(unavailable());
    }
    this.openingDeadline = openingDeadline; // Before any preparation or loader IO.
    // Publish the ORIGINAL open promise before any callback can re-enter stop.
    this.opening = Promise.resolve().then(() => this.open());
    this.openingResult = new Promise(resolve => {
      let returned = false, timer: NodeJS.Timeout | undefined;
      const cancelTimer = clearTimeout;
      const finish = (result: DevelopmentResult) => {
        if (returned) return; returned = true; cancelTimer(timer); this.abort.signal.removeEventListener("abort", cancelled); resolve(result);
      };
      const cancelled = () => finish(unavailable());
      this.abort.signal.addEventListener("abort", cancelled, { once: true });
      timer = setTimeout(() => { this.failed = true; finish(unavailable()); void this.stop(); }, Math.max(0, openingDeadline - performance.now()));
      void this.opening!.then(async () => {
        try { this.alive(); const result = await this.getStatus(); this.alive(); finish(result); }
        catch { this.failed = true; finish(unavailable()); void this.stop(); }
      }, () => { this.failed = true; finish(unavailable()); void this.stop(); });
    });
    return this.openingResult;
  }
  stop(): Promise<NativeHostOutcome> {
    if (this.stopping) return this.stopping;
    // Publish the shared promise before abort listeners or connection callbacks
    // can synchronously re-enter stop().
    let resolveStop!: (outcome: NativeHostOutcome) => void;
    this.stopping = new Promise(resolve => { resolveStop = resolve; });
    this.cleanupDeadline = performance.now() + 30000;
    this.closing = true; this.accepting = false; this.abort.abort();
    void this.admission?.disable();
    for (const connection of this.connections.values()) void connection.stop();
    this.closingWork = this.close();
    void this.bound(this.closingWork, 30000, this.cleanupDeadline).then(result => {
      if (!result) this.cleanupAbort.abort();
      resolveStop(result ?? Object.freeze({
      descriptorRemoved: false, helperExitVerified: false, originalResourceWorkSettled: false,
      resourceOwnerHealthy: false, backendRevoked: false, listenerClosed: false,
      brokerCleanupReported: false, reservationCreated: this.reservationCreated, reservationReleased: false, failed: true,
    }));
    });
    return this.stopping;
  }
  private alive() {
    if (this.closing || this.abort.signal.aborted || !this.openingDeadline || performance.now() >= this.openingDeadline)
      throw new Error("Native development opening stopped or expired.");
  }
  private resourceWorkSettled(): boolean {
    return this.loadingCall?.settled === true && this.bindingValid && !!this.resources && this.resourceCalls.every(call => call.settled) && !this.resources.status().pending;
  }
  private resourceOwnerHealthy(): boolean {
    return this.loadingCall?.settled === true && !this.loadingCall.failed && this.bindingValid && !!this.resources && !this.resources.status().failed && this.resourceCalls.every(call => !call.failed && call.exitVerified);
  }
  private mutationAllowed(): boolean {
    return this.cleanupWithinBudget() && this.helpersSettled && this.resourceWorkSettled() && this.resourceOwnerHealthy();
  }
  private async resource<T>(start: (resources: NativeDevelopmentResources) => Promise<T>): Promise<T> {
    const resources = this.resources;
    if (!resources) throw new Error("Native Host resources unavailable.");
    let original: Promise<T>;
    try { original = start(resources); }
    catch (error) { this.failed = true; this.helpersSettled = false; throw error; }
    const call = new NativeDevelopmentResourceCall(original);
    this.resourceCalls.push(call as NativeDevelopmentResourceCall<unknown>);
    call.bind(resources); // Original is already retained and handled.
    if (!call.observationAvailable) { this.failed = true; this.helpersSettled = false; throw new Error("Native Host call observation unavailable."); }
    try {
      const result = await call.result; await call.observed;
      if (call.failed || !call.settled || !call.exitVerified) throw new Error("Native Host original call not verified.");
      return result;
    } catch (error) {
      this.failed = true;
      if (error && typeof error === "object" && "exitVerified" in error && error.exitVerified === false) this.helpersSettled = false;
      throw error;
    }
  }
  private async open(): Promise<void> {
    try {
      this.alive();
      this.loading = this.loadResources(this.openingDeadline, this.abort.signal);
      const loading = new NativeDevelopmentLoadCall(this.loading);
      this.loadingCall = loading; // Retain original + both handlers BEFORE lookup.
      loading.bind(this.loadResources);
      if (!loading.observationAvailable) throw new Error("Native loader observation unavailable.");
      const resources = await loading.result;
      await loading.observed; this.alive(); // Original IO, under the original opening deadline.
      if (!loading.settled || loading.failed) throw new Error("Original native preparation not verified.");
      this.resources = resources; this.alive();
      if (this.resources.controlFile !== this.file) throw new Error("Native Host control binding differs.");
      this.bindingValid = true; this.alive();
      await this.resource(resources => resources.prepareDirectory(this.openingDeadline, this.abort.signal)); this.alive();
      // A fixed CREATE_NEW reservation fences crashes. Only the explicit
      // native release paths in close() may remove it. Opening never
      // repairs, deletes or bypasses an existing reservation.
      await mkdir(join(this.directory, "native-session-reserved")); this.reservationCreated = true; this.alive();
      const entries = await opendir(join(this.directory, "native-session-reserved"));
      try { this.alive(); const entry = await entries.read(); this.alive(); if (entry) throw new Error("Native reservation is not empty."); }
      finally { await entries.close(); }
      this.alive();
      await this.resource(resources => resources.bootstrap("recover", undefined, this.openingDeadline, this.abort.signal));
      this.descriptorState = "absent"; this.alive();
      // Identity/ticket construction is local; no backend configuration or
      // admission listener exists until native preparation and sealing finish.
      const main = await this.resource(resources => resources.identity(this.openingDeadline, this.abort.signal)); this.alive();
      const epoch = randomBytes(32).toString("hex"), pipeNonce = randomBytes(16).toString("hex");
      this.admission = new NativeDevelopmentAdmission(this.backend, epoch);
      const ticket = this.admission.issueTicket();
      if (!ticket) throw new Error("Native admission unavailable.");
      this.descriptor = encodeNativeBootstrap({ main, pipeNonce, ticket });
      await this.resource(resources => resources.session("prepare", this.descriptor!, this.openingDeadline, this.abort.signal)); this.alive();
      await this.resource(resources => resources.prepareWorker(this.openingDeadline, this.abort.signal)); this.alive();
      await this.resource(resources => resources.session("seal", this.descriptor!, this.openingDeadline, this.abort.signal));
      this.sessionSealed = true; this.alive();
      // A failed acknowledgement can still mean the backend changed; revoke it.
      this.configuration = Promise.resolve().then(() => {
        this.alive(); this.epochConfigured = true;
        return this.backend.development("development.configure", epoch);
      });
      const configured = await this.configuration; this.alive();
      if (!configured.ok || !("status" in configured) || !configured.status.enabled) throw new Error("Native backend unavailable.");
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
      this.descriptorWork = this.resource(resources => resources.session("publish", this.descriptor!, this.openingDeadline, this.abort.signal))
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
      consume: async (ticket, signal, deadline) => {
        signal.throwIfAborted(); requireNativeOperationDeadline(deadline);
        await this.descriptorWork;
        signal.throwIfAborted(); requireNativeOperationDeadline(deadline);
        if (this.descriptorState !== "published" || !this.descriptor
          || this.descriptor.subarray(48, 64).toString("hex") !== ticket.generation
          || this.descriptor.subarray(64).toString("hex") !== ticket.token) throw new Error("Native descriptor mismatch.");
        this.descriptorState = "consuming";
        this.descriptorWork = this.resource(resources => resources.bootstrap("consume", this.descriptor, deadline, signal))
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
  private cleanupWithinBudget(): boolean {
    if (!this.cleanupDeadline || performance.now() >= this.cleanupDeadline) this.cleanupAbort.abort();
    return !this.cleanupAbort.signal.aborted;
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
    // This is the retained original preparation, never the public timeout.
    await this.bound(this.loadingCall?.observed ?? Promise.resolve(), 30000, this.cleanupDeadline);
    const stopped = await stoppedWork;
    const detached = await detachedWork;
    const revoked = await revokedWork;
    await this.descriptorWork?.catch(() => {});
    // Observe only original work under the ORIGINAL whole-close deadline.
    await this.bound(Promise.all(this.resourceCalls.map(call => call.observed)), 30000, this.cleanupDeadline);
    if (this.mutationAllowed() && this.descriptorState === "published" && this.descriptor) {
      this.descriptorState = "consuming";
      try { await this.resource(resources => resources.bootstrap("consume", this.descriptor, this.cleanupDeadline, this.cleanupAbort.signal)); this.descriptorState = "removed"; }
      catch { this.descriptorState = "uncertain"; }
    }
    const listenerClosed = await this.bound(listener, 3000, this.cleanupDeadline) === true;
    const release = assessNativeMcpRelease([...this.outcomes, ...stopped]);
    const brokerCleanupReported = release.brokerCleanupReported;
    this.failed ||= release.failed;
    const descriptorRemoved = this.descriptorState === "absent" || this.descriptorState === "removed";
    let reservationReleased = false;
    const releaseOperation = release.operation;
    // A complete terminal outcome selects only a fixed request. Native code
    // still decides READY versus ADMITTED/CLEAN under the original lease and
    // fresh process/Job checks. Neither missing CLEAN nor failure downgrades
    // an admitted generation to pristine, and no mode is attempted as fallback.
    if (this.mutationAllowed() && !this.failed && this.sessionSealed && this.reservationCreated
      && descriptorRemoved && this.descriptor && this.helpersSettled && detached && revoked && listenerClosed
      && releaseOperation) {
      try {
        await this.resource(resources => resources.session(releaseOperation, this.descriptor!, this.cleanupDeadline, this.cleanupAbort.signal));
        if (!this.cleanupWithinBudget()) throw new Error("Native release exceeded cleanup deadline.");
        reservationReleased = true;
      } catch { this.failed = true; }
    }
    await this.bound(Promise.all(this.resourceCalls.map(call => call.observed)), 30000, this.cleanupDeadline);
    this.descriptor?.fill(0);
    const originalResourceWorkSettled = this.resourceWorkSettled(), resourceOwnerHealthy = this.resourceOwnerHealthy();
    const helperExitVerified = this.helpersSettled && this.resourceCalls.every(call => call.exitVerified);
    const withinBudget = this.cleanupWithinBudget();
    return Object.freeze({ descriptorRemoved, helperExitVerified, originalResourceWorkSettled, resourceOwnerHealthy, backendRevoked: revoked,
      listenerClosed, brokerCleanupReported, reservationCreated: this.reservationCreated, reservationReleased,
      failed: this.failed || !detached || !revoked || !listenerClosed || this.attempted && (!descriptorRemoved || !withinBudget) || !helperExitVerified || this.attempted && (!originalResourceWorkSettled || !resourceOwnerHealthy)
        || release.failed });
  }
  private bound<T>(work: Promise<T>, milliseconds: number, absolute?: number): Promise<T | undefined> {
    return new Promise(resolve => {
      let settled = false; const deadline = Math.min(performance.now() + milliseconds, absolute ?? Infinity);
      const cancelTimer = clearTimeout;
      const finish = (value?: T) => {
        if (!settled) { settled = true; cancelTimer(timer); resolve(performance.now() >= deadline ? undefined : value); }
      };
      const timer = setTimeout(() => finish(), Math.max(0, deadline - performance.now()));
      void work.then(finish, () => finish());
    });
  }
}
