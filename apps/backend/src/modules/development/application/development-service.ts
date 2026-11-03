import { MODEL_ID } from "@tahtiapuri/validation/assistant";
import type { DevelopmentIdentity, DevelopmentInvocation, DevelopmentResult } from "@tahtiapuri/validation/development";
import type { DevelopmentModelQueue } from "../ports/model-queue.js";
const unavailable = (): DevelopmentResult => ({ ok: false, code: "ENGINE_UNAVAILABLE" });
export class DevelopmentService {
  private epoch: string | null = null;
  private clients = new Set<string>();
  constructor(private readonly assistant: DevelopmentModelQueue | undefined) {}
  status(): DevelopmentResult {
    return { ok: true, status: { enabled: this.epoch !== null, connected: this.clients.size > 0, protocolVersion: 1, modelId: MODEL_ID, engineVersion: "3.22.2" } };
  }
  configure(epoch: string | null): DevelopmentResult {
    const previous = this.epoch;
    this.epoch = null;
    for (const clientId of this.clients) this.assistant?.releaseOwner(this.owner(previous!, clientId));
    this.clients.clear();
    this.epoch = epoch;
    return this.status();
  }
  attach(identity: DevelopmentIdentity): DevelopmentResult {
    if (!this.allowedEpoch(identity.epoch) || this.clients.size !== 0) return unavailable();
    this.clients.add(identity.clientId);
    return this.status();
  }
  detach(identity: DevelopmentIdentity): DevelopmentResult {
    if (!this.allowed(identity)) return unavailable();
    this.clients.delete(identity.clientId);
    this.assistant?.releaseOwner(this.owner(identity.epoch, identity.clientId));
    return this.status();
  }
  invoke(call: DevelopmentInvocation): DevelopmentResult {
    if (!this.allowed(call)) return unavailable();
    const owner = this.owner(call.epoch, call.clientId);
    if (call.operation === "status" && call.input === null) return this.status();
    if (!this.assistant) return unavailable();
    return call.operation === "probe" ? this.assistant.submit(call.input, owner)
      : call.operation === "cancel" ? this.assistant.cancel(call.input, owner)
      : this.assistant.get(call.input!, owner);
  }
  private allowedEpoch(epoch: string) { return this.epoch !== null && epoch === this.epoch; }
  private allowed(identity: DevelopmentIdentity) { return this.allowedEpoch(identity.epoch) && this.clients.has(identity.clientId); }
  private owner(epoch: string, clientId: string) { return "mcp:" + epoch + ":" + clientId; }
}
