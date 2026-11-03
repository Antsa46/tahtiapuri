import type { ModelInput, AssistantResult } from "@tahtiapuri/validation/assistant";
export interface DevelopmentModelQueue {
  submit(input: ModelInput, owner: string): AssistantResult;
  get(id: string, owner: string): AssistantResult;
  cancel(id: string, owner: string): AssistantResult;
  releaseOwner(owner: string): void;
}
