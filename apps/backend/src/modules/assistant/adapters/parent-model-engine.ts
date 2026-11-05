import type { ModelEngine } from "../ports/model-engine.js";
import { isModelResult, isModelProgress, MODEL_TIME_BUDGET } from "@tahtiapuri/validation/model-wire";
import type { EngineReply, ModelInput } from "@tahtiapuri/validation/assistant";
type Pending = { resolve(reply: EngineReply): void; progress(): void; timer: NodeJS.Timeout; timedOut: boolean };
const failure = (error: EngineReply["error"]): EngineReply => ({ text: "", error, info: null });
export class ParentModelEngine implements ModelEngine {
  private session: string | undefined;
  private unavailable = false;
  private pending = new Map<string, Pending>();
  constructor(private readonly send: (message: unknown) => void) {}
  initialize(session: string) {
    // A fresh session requires a fresh adapter. Reinitialization cannot clear an
    // uncertain worker's ownership or revive an abandoned channel.
    if (!this.session && !this.unavailable) this.session = session;
  }
  run(id: string, input: ModelInput, progress: () => void): Promise<EngineReply> {
    if (!this.session || this.unavailable) return Promise.resolve(failure("ENGINE_UNAVAILABLE"));
    if (this.pending.size) return Promise.resolve(failure("BUSY"));
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        pending.timedOut = true;
        // Request cancellation, but do not release the application queue until
        // the owner reports a terminal result or this adapter is permanently retired.
        pending.timer = setTimeout(() => this.retire(), MODEL_TIME_BUDGET.cancelAckMs);
        this.cancel(id);
      }, MODEL_TIME_BUDGET.resultMs);
      this.pending.set(id, { resolve, progress, timer, timedOut: false });
      try { this.send({ type: "model.run", session: this.session, id, input }); }
      catch { this.retire(); }
    });
  }
  cancel(id: string) {
    if (!this.session || this.unavailable || !this.pending.has(id)) return;
    try { this.send({ type: "model.cancel", session: this.session, id }); }
    catch { this.retire(); }
  }
  /** Retire the owning transport and release all model-result timers. */
  dispose(): void { this.retire(); }
  private retire() {
    this.unavailable = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(failure(pending.timedOut ? "TIMEOUT" : "ENGINE_UNAVAILABLE"));
    }
    this.pending.clear();
  }
  receive(message: unknown): boolean {
    if (!this.session || this.unavailable) return false;
    if (isModelProgress(message, this.session)) {
      const pending = this.pending.get(message.id);
      if (pending && !pending.timedOut) pending.progress();
      return true;
    }
    if (!isModelResult(message, this.session)) return false;
    const pending = this.pending.get(message.id);
    if (!pending) return false;
    clearTimeout(pending.timer); this.pending.delete(message.id);
    pending.resolve(pending.timedOut ? failure("TIMEOUT") : message.reply);
    return true;
  }
}
