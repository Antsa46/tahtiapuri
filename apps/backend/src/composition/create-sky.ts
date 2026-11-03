import { SkyService } from "../modules/sky/application/sky-service.js";
import { AstronomyCalculator } from "../modules/sky/adapters/astronomy-calculator.js";
import { loadLocalStarCatalog } from "../modules/sky/adapters/local-star-catalog.js";
export async function createSky(catalogDirectory: string): Promise<SkyService> {
  return new SkyService(new AstronomyCalculator(), await loadLocalStarCatalog(catalogDirectory));
}
