import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isBridgeCommand, isCapability, type BridgeCommand, type DevelopmentIdentity, type DevelopmentResult } from "@tahtiapuri/validation/development";
import type { BackendController } from "./backend-controller.js";

const unavailable = (): DevelopmentResult => ({ ok: false, code: "ENGINE_UNAVAILABLE" });
export type NativeAdmissionPhase = "idle" | "available" | "attaching" | "active" | "detaching" | "disabled";
export type NativeLaunchTicket = Readonly<{ generation: string; token: string }>;
export interface NativeDevelopmentLease {
  readonly ready: Promise<boolean>;
  invoke(command: BridgeCommand): Promise<DevelopmentResult>;
  close(): Promise<boolean>;
}
type Backend = Pick<BackendController, "development">;
interface Session {
  identity: DevelopmentIdentity;
  attaching: Promise<DevelopmentResult>;
  active: boolean;
  closing: boolean;
  closed?: Promise<boolean>;
}

/** Main-owned capability admission for the native path. The owner configures the backend
 * epoch before publishing a ticket and revokes it on disable/failure. This
 * class never publishes files, authenticates OS peers, or proves worker exit. */
export class NativeDevelopmentAdmission {
  private phaseValue: NativeAdmissionPhase = "idle";
  private disabled = false;
  private token: string | undefined;
  private previousToken: string | undefined;
  private session: Session | undefined;
  private pending = 0;
  readonly generation = randomBytes(16).toString("hex");
  constructor(private readonly backend: Backend, private readonly epoch: string, private readonly timeoutMs = 3000) {
    if (!isCapability(epoch) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
      throw new Error("Invalid native admission configuration.");
  }
  get phase(): NativeAdmissionPhase { return this.phaseValue; }

  /** Exactly one outstanding ticket. Publication failure requires disable(),
   * not restoration/republication of a consumed ticket. */
  issueTicket(): NativeLaunchTicket | undefined {
    if (this.disabled || this.phaseValue !== "idle" || this.session || this.token) return undefined;
    const token = randomBytes(32).toString("hex");
    if (token === this.epoch || token === this.previousToken) { this.fail(); return undefined; }
    this.token = token; this.phaseValue = "available";
    return Object.freeze({ generation: this.generation, token });
  }

  /** Claim is synchronous: the ticket and the single client slot are consumed
   * before any asynchronous backend work. No legacy epoch authentication. */
  claim(generation: unknown, token: unknown): NativeDevelopmentLease | undefined {
    if (this.disabled || this.phaseValue !== "available" || this.session || !this.token
      || generation !== this.generation || !isCapability(token)
      || !timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(this.token, "hex"))) return undefined;
    this.previousToken = this.token; this.token = undefined; this.phaseValue = "attaching";
    const identity = { epoch: this.epoch, clientId: randomUUID() };
    const session: Session = { identity, active: false, closing: false,
      attaching: Promise.resolve().then(() => this.backend.development("development.attach", identity)) };
    this.session = session;
    const ready = this.bounded(session.attaching).then(result => {
      if (!result?.ok || !("status" in result) || !result.status.enabled || !result.status.connected) {
        this.fail(); void this.closeSession(session); return false;
      }
      if (this.disabled || session.closing || this.session !== session) { void this.closeSession(session); return false; }
      session.active = true; this.phaseValue = "active"; return true;
    });
    return Object.freeze({ ready,
      invoke: (command: BridgeCommand) => this.invoke(session, command),
      close: () => this.closeSession(session),
    });
  }

  /** Stops admission synchronously, even while attach or publication is pending.
   * The result proves only backend-client settlement, not native cleanup. */
  disable(): Promise<boolean> {
    this.fail(); return this.session ? this.closeSession(this.session) : Promise.resolve(true);
  }
  private fail() {
    this.disabled = true; this.token = undefined; this.phaseValue = "disabled";
    if (this.session) this.session.active = false;
  }
  private async invoke(session: Session, command: BridgeCommand): Promise<DevelopmentResult> {
    if (!this.usable(session) || !isBridgeCommand(command)) return unavailable();
    if (this.pending >= 4) return { ok: false, code: "BUSY" };
    this.pending++;
    try {
      const result = await this.bounded(Promise.resolve().then(() => {
        // Disable may arrive between call admission and this asynchronous dispatch.
        if (!this.usable(session)) return unavailable();
        return this.backend.development("development.invoke", { ...session.identity, operation: command.operation, input: command.input });
      }));
      if (!result) {
        // An old request may settle after its lease detached and a new client
        // attached. Only the still-active owner may disable this generation.
        if (this.usable(session)) { this.fail(); void this.closeSession(session); }
        return unavailable();
      }
      return this.usable(session) ? result : unavailable();
    } finally { this.pending--; }
  }

  private usable(session: Session) { return !this.disabled && this.session === session && session.active && !session.closing; }

  private closeSession(session: Session): Promise<boolean> {
    if (session.closed) return session.closed;
    session.closing = true; session.active = false;
    if (!this.disabled) this.phaseValue = "detaching";
    // Always attempt this identity's detach after the raw attach has settled,
    // including a lost/failed acknowledgement. Never overlap old detach with
    // a newly issued ticket. Late settlement after timeout remains disabled.
    const settlement = session.attaching.catch(() => undefined).then(() =>
      this.backend.development("development.detach", session.identity));
    session.closed = this.bounded(settlement).then(result => {
      const settled = !!result?.ok && "status" in result && !result.status.connected;
      if (!settled) { this.fail(); return false; }
      if (this.session === session) {
        this.session = undefined;
        if (!this.disabled) this.phaseValue = "idle";
      }
      return true;
    });
    return session.closed;
  }
  private bounded<T>(work: Promise<T>): Promise<T | undefined> {
    return new Promise(resolve => {
      let finished = false;
      const finish = (value: T | undefined) => { if (!finished) { finished = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => finish(undefined), this.timeoutMs);
      void work.then(finish, () => finish(undefined));
    });
  }
}
