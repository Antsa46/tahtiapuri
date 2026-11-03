import { isCapability, isDevelopmentIdentity, isDevelopmentInvocation, isDevelopmentResult, type DevelopmentResult } from "./development.js";
import { isModelInput, isJobId, isAssistantResult, type AssistantResult } from "./assistant.js";
import { exactKeys, isRecord, isRuntimeStatus, type RuntimeStatus } from "./public-api.js";
import { isObservationRequest, isSkySelectionRequest, isSkyResult, isSkySelectionResult, type SkyResult, type SkySelectionResult } from "./sky.js";
export const PROTOCOL_VERSION = 1;
export const MAX_REQUEST_MS = 5000;
export const OPERATIONS = ["sky.snapshot", "sky.select", "runtime.status", "runtime.ping", "runtime.shutdown", "assistant.submit", "assistant.get", "assistant.cancel", "development.status", "development.configure", "development.attach", "development.detach", "development.invoke"] as const;
export type Operation = typeof OPERATIONS[number];
export type Initialize = { type: "initialize"; protocol: 1; session: string };
export type Ready = { type: "ready"; protocol: 1; session: string };
export type Request = {
  type: "request"; protocol: 1; session: string; id: string;
  operation: Operation; expiresAtUnixMs: number; input?: unknown;
};
export type Response = {
  type: "response"; protocol: 1; session: string; id: string;
  operation: Operation; result: RuntimeStatus | AssistantResult | DevelopmentResult | SkyResult | SkySelectionResult | null;
};
export function isSession(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
export function isInitialize(value: unknown): value is Initialize {
  return isRecord(value) && exactKeys(value, ["type", "protocol", "session"])
    && value.type === "initialize" && value.protocol === 1 && isSession(value.session);
}
export function isReady(value: unknown, session: string): value is Ready {
  return isRecord(value) && exactKeys(value, ["type", "protocol", "session"])
    && value.type === "ready" && value.protocol === 1 && value.session === session;
}
function isEnvelope(value: unknown, session: string): value is Record<string, unknown> {
  return isRecord(value) && value.protocol === 1 && value.session === session
    && typeof value.id === "string" && /^[a-f0-9-]{36}$/.test(value.id)
    && OPERATIONS.some(operation => operation === value.operation);
}
export function isRequest(value: unknown, session: string, now: number): value is Request {
  return isEnvelope(value, session)
    && exactKeys(value, (String(value.operation).startsWith("sky.") || String(value.operation).startsWith("assistant.") || (String(value.operation).startsWith("development.") && value.operation !== "development.status"))
      ? ["type", "protocol", "session", "id", "operation", "expiresAtUnixMs", "input"]
      : ["type", "protocol", "session", "id", "operation", "expiresAtUnixMs"])
    && (value.operation === "sky.snapshot" ? isObservationRequest(value.input)
      : value.operation === "sky.select" ? isSkySelectionRequest(value.input)
      : value.operation === "assistant.submit" ? isModelInput(value.input)
      : value.operation === "assistant.get" || value.operation === "assistant.cancel" ? isJobId(value.input)
      : value.operation === "development.configure" ? value.input === null || isCapability(value.input)
      : value.operation === "development.attach" || value.operation === "development.detach" ? isDevelopmentIdentity(value.input)
      : value.operation === "development.invoke" ? isDevelopmentInvocation(value.input) : true)
    && value.type === "request" && typeof value.expiresAtUnixMs === "number"
    && Number.isSafeInteger(value.expiresAtUnixMs)
    && value.expiresAtUnixMs > now && value.expiresAtUnixMs <= now + MAX_REQUEST_MS;
}
export function isResponse(value: unknown, session: string): value is Response {
  return isEnvelope(value, session)
    && exactKeys(value, ["type", "protocol", "session", "id", "operation", "result"])
    && value.type === "response"
    && (value.operation === "sky.snapshot" ? isSkyResult(value.result) : value.operation === "sky.select" ? isSkySelectionResult(value.result) : value.operation === "runtime.status" ? isRuntimeStatus(value.result) : String(value.operation).startsWith("assistant.") ? isAssistantResult(value.result) : String(value.operation).startsWith("development.") ? isDevelopmentResult(value.result) : value.result === null);
}
