import type { PlacesState } from "@tahtiapuri/domain";
export type LoadedPlaces = { state: PlacesState; token: string | null };
export interface PlacesRepository {
  load(): Promise<LoadedPlaces>;
  save(state: PlacesState, expectedToken: string | null, canCommit: () => boolean): Promise<void>;
}
export class PlacesStorageError extends Error {
  constructor(readonly code: "READ_FAILED" | "SAVE_FAILED" | "CONFLICT" | "UNAVAILABLE") { super(code); }
}
