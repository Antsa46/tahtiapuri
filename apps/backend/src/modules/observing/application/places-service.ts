import { randomUUID } from "node:crypto";
import { canonicalPlaceDraft, MAX_PLACES, type Place, type PlacesState } from "@tahtiapuri/domain";
import { isObservingInput, type ObservingOperation, type ObservingResult, type PlaceSave, type PlaceChoice } from "@tahtiapuri/validation/observing";
import { PlacesStorageError, type PlacesRepository } from "../ports/places-repository.js";
export class PlacesService {
  private closing = false;
  private pending: Promise<ObservingResult> | null = null;
  constructor(private readonly repository: PlacesRepository, private readonly now: () => number = Date.now) {}
  execute(operation: ObservingOperation, input: unknown, expiresAtUnixMs: number): Promise<ObservingResult> {
    if (!isObservingInput(operation, input)) return Promise.resolve({ ok: false, code: "INVALID_INPUT" });
    if (this.closing || this.now() >= expiresAtUnixMs) return Promise.resolve({ ok: false, code: "UNAVAILABLE" });
    if (this.pending) return Promise.resolve({ ok: false, code: "BUSY" });
    const task = this.run(operation, input, expiresAtUnixMs);
    this.pending = task;
    void task.finally(() => { if (this.pending === task) this.pending = null; });
    return task;
  }
  private async run(operation: ObservingOperation, input: unknown, deadline: number): Promise<ObservingResult> {
    try {
      const loaded = await this.repository.load(), previous = loaded.state;
      if (operation === "observing.read") return { ok: true, state: previous };
      const request = input as PlaceSave | PlaceChoice;
      if (request.expectedRevision !== previous.revision) return { ok: false, code: "CONFLICT" };
      if (previous.revision >= 2_147_483_646) return { ok: false, code: "LIMIT_REACHED" };
      let state: PlacesState;
      if (operation === "observing.save") {
        const save = input as PlaceSave, draft = canonicalPlaceDraft(save.place);
        if (save.id !== null && !previous.places.some(p => p.id === save.id)) return { ok: false, code: "INVALID_INPUT" };
        if (save.id === null && previous.places.length >= MAX_PLACES) return { ok: false, code: "LIMIT_REACHED" };
        if (previous.places.some(p => p.id !== save.id && p.name.toLocaleLowerCase("fi") === draft.name.toLocaleLowerCase("fi"))) return { ok: false, code: "DUPLICATE_NAME" };
        const place: Place = { id: save.id ?? "site-" + randomUUID(), ...draft };
        state = { revision: previous.revision + 1, places: save.id ? previous.places.map(p => p.id === place.id ? place : p) : [...previous.places, place], activePlaceId: place.id };
      } else {
        const choice = input as PlaceChoice;
        if (!previous.places.some(p => p.id === choice.id)) return { ok: false, code: "INVALID_INPUT" };
        state = operation === "observing.activate" ? { ...previous, revision: previous.revision + 1, activePlaceId: choice.id }
          : { revision: previous.revision + 1, places: previous.places.filter(p => p.id !== choice.id), activePlaceId: previous.activePlaceId === choice.id ? null : previous.activePlaceId };
      }
      await this.repository.save(state, loaded.token, () => !this.closing && this.now() < deadline);
      return { ok: true, state };
    } catch (error) { return { ok: false, code: error instanceof PlacesStorageError ? error.code : operation === "observing.read" ? "READ_FAILED" : "SAVE_FAILED" }; }
  }
  async close(): Promise<void> { this.closing = true; await this.pending; }
}
