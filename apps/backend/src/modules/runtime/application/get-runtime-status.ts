import type { RuntimeStatus } from "@tahtiapuri/validation/public";
export function getRuntimeStatus(modelManaged = false): RuntimeStatus {
  return { state: "ready", model: modelManaged ? "managed-separately" : "not-loaded", protocolVersion: 1 };
}
