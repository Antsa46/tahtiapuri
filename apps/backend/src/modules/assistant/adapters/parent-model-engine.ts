import type { ModelEngine } from "../ports/model-engine.js";
import { isModelResult, isModelProgress } from "@tahtiapuri/validation/model-wire";
import type { EngineReply, ModelInput } from "@tahtiapuri/validation/assistant";
export class ParentModelEngine implements ModelEngine {
  private session: string | undefined;
  private pending = new Map<string, { resolve(reply: EngineReply): void; progress(): void; timer: NodeJS.Timeout }>();
  constructor(private readonly send: (message: unknown) => void) {}
  initialize(session: string) { this.session = session; }
  run(id: string, input: ModelInput, progress: () => void): Promise<EngineReply> {
    if (!this.session) return Promise.resolve({ text: "", error: "ENGINE_UNAVAILABLE", info: null });
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.cancel(id);
        resolve({ text: "", error: "TIMEOUT", info: null });
      }, 185_000);
      this.pending.set(id, { resolve, progress, timer });
      try { this.send({ type: "model.run", session: this.session, id, input }); }
      catch { this.unavailable(id); }
    });
  }
  cancel(id: string) {
    if (!this.session) return;
    try { this.send({ type: "model.cancel", session: this.session, id }); }
    catch { this.unavailable(id); }
  }
  private unavailable(id: string) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(id);
    pending.resolve({ text: "", error: "ENGINE_UNAVAILABLE", info: null });
  }
  receive(message: unknown): boolean {
    if (!this.session) return false;
    if (isModelProgress(message, this.session)) { this.pending.get(message.id)?.progress(); return true; }
    if (!isModelResult(message, this.session)) return false;
    const pending = this.pending.get(message.id);
    if (!pending) return false;
    clearTimeout(pending.timer); this.pending.delete(message.id); pending.resolve(message.reply);
    return true;
  }
}
