import { isObservationRequest, isSkyResult, isSkySelectionRequest, isSkySelectionResult, type SkyBridge, type SkyResult, type SkySelectionResult, type ObservationRequest, type SkySelectionRequest } from "@tahtiapuri/validation/sky";
export function createSkyClient(bridge: SkyBridge | undefined) {
  return {
    async snapshot(input: ObservationRequest): Promise<SkyResult> {
      if (!isObservationRequest(input)) return { ok: false, code: "INVALID_INPUT" };
      try {
        const result: unknown = await bridge?.snapshot(input);
        return isSkyResult(result) ? result : { ok: false, code: "UNAVAILABLE" };
      } catch { return { ok: false, code: "UNAVAILABLE" }; }
    },
    async select(input: SkySelectionRequest): Promise<SkySelectionResult> {
      if (!isSkySelectionRequest(input)) return { ok: false, code: "INVALID_INPUT" };
      try {
        const result: unknown = await bridge?.select(input);
        return isSkySelectionResult(result) ? result : { ok: false, code: "UNAVAILABLE" };
      } catch { return { ok: false, code: "UNAVAILABLE" }; }
    },
  };
}
