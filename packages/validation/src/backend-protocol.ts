import { exactKeys, isRecord, isRuntimeStatus, type RuntimeStatus } from "./public-api.js";
export const PROTOCOL_VERSION = 1;
export const MAX_REQUEST_MS = 5000;
export const OPERATIONS = ["runtime.status", "runtime.ping", "runtime.shutdown"] as const;
export type Operation = typeof OPERATIONS[number];
export type Initialize = { type: "initialize"; protocol: 1; session: string };
export type Ready = { type: "ready"; protocol: 1; session: string };
export type Request = {
  type: "request"; protocol: 1; session: string; id: string;
  operation: Operation; expiresAtUnixMs: number;
};
export type Response = {
  type: "response"; protocol: 1; session: string; id: string;
  operation: Operation; result: RuntimeStatus | null;
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
    && exactKeys(value, ["type", "protocol", "session", "id", "operation", "expiresAtUnixMs"])
    && value.type === "request" && typeof value.expiresAtUnixMs === "number"
    && Number.isSafeInteger(value.expiresAtUnixMs)
    && value.expiresAtUnixMs > now && value.expiresAtUnixMs <= now + MAX_REQUEST_MS;
}
export function isResponse(value: unknown, session: string): value is Response {
  return isEnvelope(value, session)
    && exactKeys(value, ["type", "protocol", "session", "id", "operation", "result"])
    && value.type === "response"
    && (value.operation === "runtime.status" ? isRuntimeStatus(value.result) : value.result === null);
}
