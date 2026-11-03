import { canonicalPlaceDraft, MAX_PLACES, type Place, type PlaceDraft, type PlacesState } from "@tahtiapuri/domain";
import { exactKeys, isRecord } from "./public-api.js";
export type { Place, PlaceDraft, PlacesState } from "@tahtiapuri/domain";
export const OBSERVING_CHANNELS = { read: "tahtiapuri:places-read", save: "tahtiapuri:places-save", remove: "tahtiapuri:places-remove", activate: "tahtiapuri:places-activate" } as const;
export type ObservingOperation = "observing.read" | "observing.save" | "observing.remove" | "observing.activate";
export type PlaceSave = { expectedRevision: number; id: string | null; place: PlaceDraft };
export type PlaceChoice = { expectedRevision: number; id: string };
export type ObservingErrorCode = "INVALID_INPUT" | "READ_FAILED" | "SAVE_FAILED" | "CONFLICT" | "LIMIT_REACHED" | "DUPLICATE_NAME" | "BUSY" | "UNAVAILABLE";
export type ObservingResult = { ok: true; state: PlacesState } | { ok: false; code: ObservingErrorCode };
export interface ObservingBridge {
  read(): Promise<ObservingResult>;
  save(input: PlaceSave): Promise<ObservingResult>;
  remove(input: PlaceChoice): Promise<ObservingResult>;
  activate(input: PlaceChoice): Promise<ObservingResult>;
}
export const isPlaceId = (v: unknown): v is string => typeof v === "string" && /^site-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const revision = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v < 2_147_483_647;
export function isPlaceDraft(value: unknown): value is PlaceDraft {
  if (!isRecord(value) || !exactKeys(value, ["name", "observer", "timeZone"]) || !isRecord(value.observer)) return false;
  try { canonicalPlaceDraft(value as PlaceDraft); return true; } catch { return false; }
}
export function isPlacesState(value: unknown): value is PlacesState {
  if (!isRecord(value) || !exactKeys(value, ["revision", "places", "activePlaceId"]) || !revision(value.revision)
    || !Array.isArray(value.places) || value.places.length > MAX_PLACES) return false;
  const places = value.places;
  if (!places.every(p => isRecord(p) && exactKeys(p, ["id", "name", "observer", "timeZone"]) && isPlaceId(p.id)
    && isPlaceDraft({ name: p.name, observer: p.observer, timeZone: p.timeZone }) && canonicalPlaceDraft(p as Place).name === p.name)) return false;
  return new Set(places.map(p => p.id)).size === places.length && new Set(places.map(p => p.name.toLocaleLowerCase("fi"))).size === places.length
    && (value.activePlaceId === null || isPlaceId(value.activePlaceId) && places.some(p => p.id === value.activePlaceId));
}
export function isObservingInput(operation: ObservingOperation, input: unknown): boolean {
  if (operation === "observing.read") return input === undefined;
  if (!isRecord(input) || !revision(input.expectedRevision)) return false;
  return operation === "observing.save"
    ? exactKeys(input, ["expectedRevision", "id", "place"]) && (input.id === null || isPlaceId(input.id)) && isPlaceDraft(input.place)
    : exactKeys(input, ["expectedRevision", "id"]) && isPlaceId(input.id);
}
export function isObservingResult(value: unknown): value is ObservingResult {
  return isRecord(value) && (value.ok === true ? exactKeys(value, ["ok", "state"]) && isPlacesState(value.state)
    : value.ok === false && exactKeys(value, ["ok", "code"]) && typeof value.code === "string"
      && ["INVALID_INPUT", "READ_FAILED", "SAVE_FAILED", "CONFLICT", "LIMIT_REACHED", "DUPLICATE_NAME", "BUSY", "UNAVAILABLE"].includes(value.code));
}
