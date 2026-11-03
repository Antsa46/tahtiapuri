import type { ObservationContext, SkySnapshot, StarCatalog } from "@tahtiapuri/domain";
export interface SkyCalculator { calculate(context: ObservationContext, catalog: StarCatalog): SkySnapshot; }
export interface StarCatalogPort { get(): StarCatalog; }
