import { observationContext, type ObservationRequest, type SkySnapshot } from "@tahtiapuri/domain";
import type { SkyCalculator, StarCatalogPort } from "../ports/sky-calculator.js";
export class SkyService {
  constructor(private readonly calculator: SkyCalculator, private readonly catalog: StarCatalogPort) {}
  calculate(request: ObservationRequest): SkySnapshot {
    return this.calculator.calculate(observationContext(request), this.catalog.get());
  }
}
