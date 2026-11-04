import { exactKeys, isRecord } from "./public-api.js";
import { isJobId, isModelInput, isEngineReply, type ModelInput, type EngineReply } from "./assistant.js";
export type ModelRun = { type: "model.run"; session: string; id: string; input: ModelInput };
export type ModelCancel = { type: "model.cancel"; session: string; id: string };
export type ModelResult = { type: "model.result"; session: string; id: string; reply: EngineReply };
export type ModelProgress = { type: "model.progress"; session: string; id: string };
export function isModelRun(value: unknown, session: string): value is ModelRun {
  return isRecord(value) && exactKeys(value, ["type", "session", "id", "input"]) && value.type === "model.run"
    && value.session === session && isJobId(value.id) && isModelInput(value.input);
}
export function isModelCancel(value: unknown, session: string): value is ModelCancel {
  return isRecord(value) && exactKeys(value, ["type", "session", "id"]) && value.type === "model.cancel"
    && value.session === session && isJobId(value.id);
}
export function isModelResult(value: unknown, session: string): value is ModelResult {
  return isRecord(value) && exactKeys(value, ["type", "session", "id", "reply"]) && value.type === "model.result"
    && value.session === session && isJobId(value.id) && isEngineReply(value.reply);
}
export function isModelProgress(value: unknown, session: string): value is ModelProgress {
  return isRecord(value) && exactKeys(value, ["type", "session", "id"]) && value.type === "model.progress"
    && value.session === session && isJobId(value.id);
}

export type ApprovedModel = { file: string; bytes: number; sha256: string; templateSha256: string };

// The owner adapter's complete job budget includes preparation and cleanup.
// The parent waits for a terminal acknowledgement before reusing its queue.
export const MODEL_TIME_BUDGET = Object.freeze({ ownerJobMs: 180_000, resultMs: 185_000, cancelAckMs: 10_000 });
