import type { RuntimeStatus } from "@tahtiapuri/validation/public";
export function getRuntimeStatus(): RuntimeStatus {
  return { state: "ready", model: "not-loaded", protocolVersion: 1 };
}
