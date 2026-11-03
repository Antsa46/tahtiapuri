import type { EngineReply, ModelInput } from "@tahtiapuri/validation/assistant";
export interface ModelEngine {
  run(id: string, input: ModelInput, onRunning: () => void): Promise<EngineReply>;
  cancel(id: string): void;
}
