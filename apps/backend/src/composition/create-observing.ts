import { JsonPlacesRepository } from "../modules/observing/adapters/json-places-repository.js";
import { PlacesService } from "../modules/observing/application/places-service.js";
/** The owner supplies the data root as the backend process working directory. */
export function createObserving(dataRoot: string): PlacesService { return new PlacesService(new JsonPlacesRepository(dataRoot)); }
