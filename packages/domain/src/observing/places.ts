import { observationContext } from "../sky/time.js";
import type { Observer } from "../sky/types.js";
export const MAX_PLACES = 16;
export type PlaceDraft = { name: string; observer: Observer; timeZone: string };
export type Place = PlaceDraft & { id: string };
export type PlacesState = { revision: number; places: readonly Place[]; activePlaceId: string | null };
export function canonicalPlaceDraft(draft: PlaceDraft): PlaceDraft {
  if (typeof draft.name !== "string" || draft.name.length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(draft.name)) throw new Error("INVALID_PLACE");
  const name = draft.name.normalize("NFC").trim();
  if (!name || name.length > 64) throw new Error("INVALID_PLACE");
  const context = observationContext({ atUtc: "2024-01-01T00:00:00.000Z", timeZone: draft.timeZone, observer: draft.observer });
  return { name, observer: context.observer, timeZone: context.timeZone };
}
