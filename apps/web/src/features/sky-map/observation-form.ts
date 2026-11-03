import { observationContext, resolveLocalTime } from "@tahtiapuri/domain";
import type { ObservationRequest, ObservationContext } from "@tahtiapuri/validation/sky";
export type ObservationDraft = { label: string; latitude: string; longitude: string; elevation: string; timeZone: string; localTime: string; offset: string };
export function draftAt(now: Date, timeZone: string, previous?: ObservationDraft): ObservationDraft {
  const context = observationContext({ atUtc: now.toISOString(), timeZone, observer: { latitudeDeg: 0, longitudeDeg: 0, elevationMeters: 0 } });
  return { label: "", latitude: "", longitude: "", elevation: "0", ...previous, timeZone, localTime: context.localTime, offset: String(context.utcOffsetMinutes) };
}
export function requestFromDraft(draft: ObservationDraft): ObservationRequest {
  if (![draft.latitude, draft.longitude, draft.elevation, draft.offset].every(v => v.trim() !== "" && Number.isFinite(Number(v)))) throw new Error("Täytä paikan koordinaatit ja ajan UTC-poikkeama.");
  const atUtc = resolveLocalTime(draft.localTime.length === 16 ? draft.localTime + ":00" : draft.localTime, draft.timeZone, Number(draft.offset));
  const context = observationContext({ atUtc, timeZone: draft.timeZone, observer: {
    latitudeDeg: Number(draft.latitude), longitudeDeg: Number(draft.longitude), elevationMeters: Number(draft.elevation),
  } });
  return { atUtc: context.atUtc, timeZone: context.timeZone, observer: context.observer };
}
export function sameObservation(a: ObservationRequest, b: ObservationRequest): boolean {
  return a.atUtc === b.atUtc && a.timeZone === b.timeZone && a.observer.latitudeDeg === b.observer.latitudeDeg
    && a.observer.longitudeDeg === b.observer.longitudeDeg && a.observer.elevationMeters === b.observer.elevationMeters;
}
export function formatObservationTime(context: ObservationContext): string {
  const minutes = context.utcOffsetMinutes, sign = minutes >= 0 ? "+" : "−", amount = Math.abs(minutes);
  return context.localTime.replace("T", " ") + " · " + context.timeZone + " (UTC" + sign + String(Math.floor(amount / 60)).padStart(2, "0") + ":" + String(amount % 60).padStart(2, "0") + ")";
}
