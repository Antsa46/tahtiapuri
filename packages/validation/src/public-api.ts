export const STATUS_CHANNEL = "tahtiapuri:runtime-status";
export type RuntimeStatus = { state: "ready"; model: "not-loaded"; protocolVersion: 1 };
export type StatusResult = { ok: true; status: RuntimeStatus } | { ok: false; code: "UNAVAILABLE" };
export interface RuntimeBridge { getStatus(): Promise<StatusResult> }
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  return isRecord(value) && exactKeys(value, ["state", "model", "protocolVersion"])
    && value.state === "ready" && value.model === "not-loaded" && value.protocolVersion === 1;
}
export function isStatusResult(value: unknown): value is StatusResult {
  return isRecord(value) && (value.ok === true
    ? exactKeys(value, ["ok", "status"]) && isRuntimeStatus(value.status)
    : value.ok === false && exactKeys(value, ["ok", "code"]) && value.code === "UNAVAILABLE");
}
