import type { ObservationContext, ObservationRequest, Observer } from "./types.js";
export class ObservationError extends Error {
  constructor(readonly code: "INVALID_TIME" | "INVALID_ZONE" | "INVALID_OBSERVER" | "INVALID_LOCAL_TIME") { super(code); }
}
const utcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
export function canonicalUtc(value: string): string {
  if (typeof value !== "string" || !utcPattern.test(value)) throw new ObservationError("INVALID_TIME");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== (value.length === 20 ? value.slice(0, -1) + ".000Z" : value)
    || date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2100) throw new ObservationError("INVALID_TIME");
  return date.toISOString();
}
function formatter(timeZone: string) {
  if (typeof timeZone !== "string" || timeZone.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(timeZone)) throw new ObservationError("INVALID_ZONE");
  try { return new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }); }
  catch { throw new ObservationError("INVALID_ZONE"); }
}
export function validateObserver(observer: Observer): Observer {
  if (!observer || Object.keys(observer).length !== 3
    || !["latitudeDeg", "longitudeDeg", "elevationMeters"].every(k => Object.hasOwn(observer, k))
    || !Number.isFinite(observer.latitudeDeg) || Math.abs(observer.latitudeDeg) > 90
    || !Number.isFinite(observer.longitudeDeg) || Math.abs(observer.longitudeDeg) > 180
    || !Number.isFinite(observer.elevationMeters) || observer.elevationMeters < -500 || observer.elevationMeters > 10_000) throw new ObservationError("INVALID_OBSERVER");
  return { ...observer };
}
export function observationContext(input: ObservationRequest): ObservationContext {
  const atUtc = canonicalUtc(input.atUtc), observer = validateObserver(input.observer);
  const parts = Object.fromEntries(formatter(input.timeZone).formatToParts(new Date(atUtc)).map(p => [p.type, p.value]));
  const localTime = parts.year + "-" + parts.month + "-" + parts.day + "T" + parts.hour + ":" + parts.minute + ":" + parts.second;
  const wall = Date.parse(localTime + "Z");
  const utcOffsetMinutes = Math.round((wall - Math.floor(Date.parse(atUtc) / 1000) * 1000) / 60_000);
  return { atUtc, observer, timeZone: input.timeZone, localTime, utcOffsetMinutes };
}
export function resolveLocalTime(localTime: string, timeZone: string, utcOffsetMinutes: number): string {
  if (typeof localTime !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(localTime)
    || !Number.isInteger(utcOffsetMinutes) || Math.abs(utcOffsetMinutes) > 840) throw new ObservationError("INVALID_LOCAL_TIME");
  const wall = new Date(localTime + "Z");
  if (!Number.isFinite(wall.getTime()) || wall.toISOString() !== localTime + ".000Z") throw new ObservationError("INVALID_LOCAL_TIME");
  const atUtc = canonicalUtc(new Date(wall.getTime() - utcOffsetMinutes * 60_000).toISOString());
  const context = observationContext({ atUtc, timeZone, observer: { latitudeDeg: 0, longitudeDeg: 0, elevationMeters: 0 } });
  if (context.localTime !== localTime || context.utcOffsetMinutes !== utcOffsetMinutes) throw new ObservationError("INVALID_LOCAL_TIME");
  return atUtc;
}
