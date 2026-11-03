import { observationContext } from "@tahtiapuri/domain";
import { isObservationRequest, isSkySelectionRequest, type SkyResult, type SkySelectionResult } from "@tahtiapuri/validation/sky";
import type { SkyService } from "./sky-service.js";
/** One catalogue, one cached observation; no persisted observer or user history. */
export class SkyQueries {
  private readonly ready: Promise<SkyService | null>;
  private cached: Extract<SkyResult, { ok: true }> | undefined;
  constructor(service: Promise<SkyService>) { this.ready = service.catch(() => null); }
  async snapshot(input: unknown): Promise<SkyResult> {
    if (!isObservationRequest(input)) return { ok: false, code: "INVALID_INPUT" };
    const service = await this.ready;
    if (!service) return { ok: false, code: "CATALOG_UNAVAILABLE" };
    try {
      const context = observationContext(input), previous = this.cached?.snapshot.context;
      if (previous && context.atUtc === previous.atUtc && context.timeZone === previous.timeZone
        && Object.entries(context.observer).every(([key, value]) => value === previous.observer[key as keyof typeof previous.observer])) return this.cached!;
      this.cached = { ok: true, snapshot: service.calculate(input) };
      return this.cached;
    } catch { return { ok: false, code: "UNAVAILABLE" }; }
  }
  async select(input: unknown): Promise<SkySelectionResult> {
    if (!isSkySelectionRequest(input)) return { ok: false, code: "INVALID_INPUT" };
    const result = await this.snapshot(input.observation);
    if (!result.ok) return result;
    const object = result.snapshot.objects.find(o => o.id === input.objectId);
    return object ? { ok: true, selection: { context: result.snapshot.context, object, sources: result.snapshot.sources } } : { ok: false, code: "INVALID_INPUT" };
  }
}
