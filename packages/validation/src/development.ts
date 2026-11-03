import { exactKeys, isRecord } from "./public-api.js";
import { isAssistantResult, isJobId, isModelInput, MODEL_ID, type AssistantResult, type ModelInput } from "./assistant.js";
export const DEVELOPMENT_CHANNELS = { status: "tahtiapuri:development-status", setEnabled: "tahtiapuri:development-enable" } as const;
export type DevelopmentStatus = { enabled: boolean; connected: boolean; protocolVersion: 1; modelId: typeof MODEL_ID; engineVersion: "3.22.2" };
export type DevelopmentResult = AssistantResult | { ok: true; status: DevelopmentStatus };
export interface DevelopmentBridge {
  getStatus(): Promise<DevelopmentResult>;
  setEnabled(enabled: boolean): Promise<DevelopmentResult>;
}
export type DevelopmentIdentity = { epoch: string; clientId: string };
export type DevelopmentInvocation = DevelopmentIdentity & (
  { operation: "status"; input: string | null } |
  { operation: "probe"; input: ModelInput } |
  { operation: "cancel"; input: string }
);
export const isCapability = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function isDevelopmentIdentity(v: unknown): v is DevelopmentIdentity {
  return isRecord(v) && exactKeys(v, ["epoch", "clientId"]) && isCapability(v.epoch) && isJobId(v.clientId);
}
export function isDevelopmentInvocation(v: unknown): v is DevelopmentInvocation {
  return isRecord(v) && exactKeys(v, ["epoch", "clientId", "operation", "input"]) && isCapability(v.epoch) && isJobId(v.clientId)
    && (v.operation === "status" ? v.input === null || isJobId(v.input) : v.operation === "probe" ? isModelInput(v.input) : v.operation === "cancel" && isJobId(v.input));
}
export function isDevelopmentResult(v: unknown): v is DevelopmentResult {
  if (isAssistantResult(v)) return true;
  if (!isRecord(v) || !exactKeys(v, ["ok", "status"]) || v.ok !== true || !isRecord(v.status)) return false;
  const s = v.status;
  return exactKeys(s, ["enabled", "connected", "protocolVersion", "modelId", "engineVersion"])
    && typeof s.enabled === "boolean" && typeof s.connected === "boolean" && (s.enabled || !s.connected)
    && s.protocolVersion === 1 && s.modelId === MODEL_ID && s.engineVersion === "3.22.2";
}
export const PIPE_PREFIX = "\\\\.\\pipe\\tahtiapuri-mcp-";
export type ConnectionDescription = { protocol: 1; pipe: string; token: string };
export function isConnectionDescription(v: unknown): v is ConnectionDescription {
  return isRecord(v) && exactKeys(v, ["protocol", "pipe", "token"]) && v.protocol === 1 && isCapability(v.token)
    && typeof v.pipe === "string" && v.pipe.startsWith(PIPE_PREFIX) && /^[a-f0-9]{32}$/.test(v.pipe.slice(PIPE_PREFIX.length));
}
export type BridgeCommand = { id: string; operation: "status"; input: string | null } |
  { id: string; operation: "probe"; input: ModelInput } | { id: string; operation: "cancel"; input: string };
export function isBridgeCommand(v: unknown): v is BridgeCommand {
  return isRecord(v) && exactKeys(v, ["id", "operation", "input"]) && isJobId(v.id)
    && (v.operation === "status" ? v.input === null || isJobId(v.input) : v.operation === "probe" ? isModelInput(v.input) : v.operation === "cancel" && isJobId(v.input));
}
