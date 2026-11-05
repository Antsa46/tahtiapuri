import { exactKeys, isRecord } from "./public-api.js";
export const ASSISTANT_CHANNELS = { submit: "tahtiapuri:model-submit", get: "tahtiapuri:model-get", cancel: "tahtiapuri:model-cancel" } as const;
export const MODEL_ID = "qwen3-4b-q4-k-m";
export const ERROR_CODES = ["BUSY", "CANCELLED", "OUT_OF_MEMORY", "MODEL_INVALID", "ENGINE_UNAVAILABLE", "ENGINE_CRASHED", "TIMEOUT", "INVALID_INPUT"] as const;
export type ModelErrorCode = typeof ERROR_CODES[number];
export type ComputeBackend = "cpu" | "cuda";
export type ModelInput = { prompt: string; backend: ComputeBackend };
export const NATIVE_ENGINE_VERSION = "llama.cpp-v0.9.0-cpu";
export type EngineInfo = { backend: ComputeBackend; gpuLayers: number; loadMs: number; generationMs: number; contextSize: number; engineVersion: "3.22.2" | typeof NATIVE_ENGINE_VERSION; modelId: typeof MODEL_ID };
export type EngineReply = { text: string; error: ModelErrorCode | null; info: EngineInfo | null };
export type JobView = { id: string; state: "queued" | "loading" | "running" | "completed" | "cancelled" | "error"; text: string; error: ModelErrorCode | null; info: EngineInfo | null };
export type AssistantResult = { ok: true; job: JobView } | { ok: false; code: ModelErrorCode };
export interface AssistantBridge {
  submit(input: ModelInput): Promise<AssistantResult>;
  get(id: string): Promise<AssistantResult>;
  cancel(id: string): Promise<AssistantResult>;
}
export const isBackend = (value: unknown): value is ComputeBackend => value === "cpu" || value === "cuda";
export const isJobId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const isErrorCode = (value: unknown): value is ModelErrorCode => ERROR_CODES.some(code => code === value);
export function isModelInput(value: unknown): value is ModelInput {
  return isRecord(value) && exactKeys(value, ["prompt", "backend"]) && isBackend(value.backend)
    && typeof value.prompt === "string" && value.prompt.trim().length > 0 && value.prompt.length <= 2000 && !value.prompt.includes("\0");
}
export function isEngineInfo(value: unknown): value is EngineInfo {
  return isRecord(value) && exactKeys(value, ["backend", "gpuLayers", "loadMs", "generationMs", "contextSize", "engineVersion", "modelId"])
    && isBackend(value.backend) && (value.engineVersion === "3.22.2" || value.engineVersion === NATIVE_ENGINE_VERSION && value.backend === "cpu") && value.modelId === MODEL_ID
    && ["gpuLayers", "loadMs", "generationMs", "contextSize"].every(key => typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0)
    && typeof value.gpuLayers === "number" && Number.isInteger(value.gpuLayers) && value.gpuLayers <= 200 && value.contextSize === 4096
    && (value.backend === "cuda" ? value.gpuLayers > 0 : value.gpuLayers === 0);
}
export function isEngineReply(value: unknown): value is EngineReply {
  return isRecord(value) && exactKeys(value, ["text", "error", "info"])
    && typeof value.text === "string" && value.text.length <= 8192
    && (value.error === null || isErrorCode(value.error))
    && (value.info === null || isEngineInfo(value.info))
    && (value.error !== null || value.info !== null);
}
export function isJobView(value: unknown): value is JobView {
  return isRecord(value) && exactKeys(value, ["id", "state", "text", "error", "info"]) && isJobId(value.id)
    && ["queued", "loading", "running", "completed", "cancelled", "error"].includes(value.state as string)
    && typeof value.text === "string" && value.text.length <= 8192
    && (value.error === null || isErrorCode(value.error)) && (value.info === null || isEngineInfo(value.info));
}
export function isAssistantResult(value: unknown): value is AssistantResult {
  return isRecord(value) && (value.ok === true ? exactKeys(value, ["ok", "job"]) && isJobView(value.job)
    : value.ok === false && exactKeys(value, ["ok", "code"]) && isErrorCode(value.code));
}
