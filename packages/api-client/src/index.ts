import { isStatusResult, type RuntimeBridge, type StatusResult } from "@tahtiapuri/validation/public";
export function createRuntimeClient(bridge: RuntimeBridge) {
  return {
    async getStatus(): Promise<StatusResult> {
      try {
        const result: unknown = await bridge.getStatus();
        return isStatusResult(result) ? result : { ok: false, code: "UNAVAILABLE" };
      } catch { return { ok: false, code: "UNAVAILABLE" }; }
    },
  };
}
export { createSkyClient } from "./sky.js";
