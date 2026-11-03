import { observationContext, compassDirection, geometricHorizon, SOLAR_BODIES, type ObservationRequest, type ObservationContext, type SkyObject, type SkySnapshot } from "@tahtiapuri/domain";
import { exactKeys, isRecord } from "./public-api.js";
export type { ObservationRequest, ObservationContext, SkyObject, SkySnapshot } from "@tahtiapuri/domain";
export const SKY_CHANNELS = { snapshot: "tahtiapuri:sky-snapshot", select: "tahtiapuri:sky-select" } as const;
export const MAX_SKY_OBJECTS = 5079;
export type SkyErrorCode = "INVALID_INPUT" | "CATALOG_UNAVAILABLE" | "UNAVAILABLE" | "BUSY";
export type SkyFailure = { ok: false; code: SkyErrorCode };
export type SkyResult = { ok: true; snapshot: SkySnapshot } | SkyFailure;
export type SkySelectionRequest = { observation: ObservationRequest; objectId: string };
export type SkySelection = { context: ObservationContext; object: SkyObject; sources: SkySnapshot["sources"] };
export type SkySelectionResult = { ok: true; selection: SkySelection } | SkyFailure;
export interface SkyBridge {
  snapshot(input: ObservationRequest): Promise<SkyResult>;
  select(input: SkySelectionRequest): Promise<SkySelectionResult>;
}
export function isObservationRequest(value: unknown): value is ObservationRequest {
  if (!isRecord(value) || !exactKeys(value, ["atUtc", "timeZone", "observer"]) || !isRecord(value.observer)) return false;
  try { observationContext(value as ObservationRequest); return true; } catch { return false; }
}
export function isObjectId(value: unknown): value is string {
  return typeof value === "string" && (SOLAR_BODIES.some(id => id === value) || /^hyg-[1-9][0-9]{0,5}$/.test(value));
}
export function isSkySelectionRequest(value: unknown): value is SkySelectionRequest {
  return isRecord(value) && exactKeys(value, ["observation", "objectId"]) && isObservationRequest(value.observation) && isObjectId(value.objectId);
}
const finite = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v);
export function isObservationContext(value: unknown): value is ObservationContext {
  if (!isRecord(value) || !exactKeys(value, ["atUtc", "timeZone", "observer", "localTime", "utcOffsetMinutes"])) return false;
  const request = { atUtc: value.atUtc, timeZone: value.timeZone, observer: value.observer };
  if (!isObservationRequest(request)) return false;
  const expected = observationContext(request);
  return value.atUtc === expected.atUtc && value.localTime === expected.localTime && value.utcOffsetMinutes === expected.utcOffsetMinutes;
}
function isSkyObject(value: unknown, atUtc: string): value is SkyObject {
  if (!isRecord(value) || !exactKeys(value, ["id", "name", "kind", "atUtc", "equatorial", "horizontal", "magnitude", "sourceId"])
    || !isObjectId(value.id) || !text(value.name, 128) || value.atUtc !== atUtc || !text(value.sourceId, 128)) return false;
  const isStar = value.id.startsWith("hyg-");
  if (value.kind !== (isStar ? "star" : value.id === "Sun" ? "sun" : value.id === "Moon" ? "moon" : "planet")) return false;
  const e = value.equatorial, h = value.horizontal, m = value.magnitude;
  return isRecord(e) && exactKeys(e, ["raHours", "decDeg", "frame", "origin"])
    && finite(e.raHours, 0, 24) && e.raHours < 24 && finite(e.decDeg, -90, 90) && e.frame === "true-equator-of-date"
    && e.origin === (isStar ? "stellar-direction" : "topocentric")
    && isRecord(h) && exactKeys(h, ["altitudeDeg", "azimuthDeg", "direction", "refraction", "horizon"])
    && finite(h.altitudeDeg, -90, 90) && (h.azimuthDeg === null ? h.direction === null && Math.abs(Math.abs(h.altitudeDeg) - 90) < 1e-7
      : finite(h.azimuthDeg, 0, 360) && h.azimuthDeg < 360 && h.direction === compassDirection(h.azimuthDeg))
    && h.refraction === "none" && h.horizon === geometricHorizon(h.altitudeDeg)
    && isRecord(m) && exactKeys(m, ["value", "kind", "sourceId"]) && (m.value === null || finite(m.value, -40, 40))
    && m.kind === (isStar ? "catalog-v" : "geocentric-visual-model") && text(m.sourceId, 128);
}
function isSources(value: unknown): value is SkySnapshot["sources"] {
  return Array.isArray(value) && value.length > 0 && value.length <= 8 && value.every(s =>
    isRecord(s) && exactKeys(s, ["id", "version", "url", "frame", "corrections"]) && text(s.id, 128) && text(s.version, 64)
    && text(s.url, 512) && /^https:\/\//.test(s.url) && text(s.frame, 64) && Array.isArray(s.corrections)
    && s.corrections.length <= 16 && s.corrections.every(c => text(c, 256)))
    && new Set(value.map(s => s.id)).size === value.length;
}
function hasSources(object: SkyObject, sources: SkySnapshot["sources"]): boolean {
  return sources.some(s => s.id === object.sourceId) && sources.some(s => s.id === object.magnitude.sourceId);
}
export function isSkySnapshot(value: unknown): value is SkySnapshot {
  if (!isRecord(value) || !exactKeys(value, ["context", "objects", "moon", "sources"]) || !isObservationContext(value.context)
    || !Array.isArray(value.objects) || value.objects.length !== MAX_SKY_OBJECTS || !isSources(value.sources)) return false;
  const sources = value.sources, atUtc = value.context.atUtc, m = value.moon, objects = value.objects;
  return objects.every(o => isSkyObject(o, atUtc) && hasSources(o, sources))
    && new Set(objects.map(o => o.id)).size === objects.length && SOLAR_BODIES.every(id => objects.some(o => o.id === id))
    && isRecord(m) && exactKeys(m, ["atUtc", "sourceId", "phaseLongitudeDeg", "phaseAngleDeg", "illuminatedFraction"])
    && m.atUtc === atUtc && sources.some(s => s.id === m.sourceId) && finite(m.phaseLongitudeDeg, 0, 360)
    && finite(m.phaseAngleDeg, 0, 180) && finite(m.illuminatedFraction, 0, 1);
}
function isFailure(value: Record<string, unknown>): value is SkyFailure {
  return exactKeys(value, ["ok", "code"]) && value.ok === false && typeof value.code === "string" && ["INVALID_INPUT", "CATALOG_UNAVAILABLE", "UNAVAILABLE", "BUSY"].includes(value.code);
}
export function isSkyResult(value: unknown): value is SkyResult {
  return isRecord(value) && (value.ok === false ? isFailure(value) : value.ok === true && exactKeys(value, ["ok", "snapshot"]) && isSkySnapshot(value.snapshot));
}
export function isSkySelectionResult(value: unknown): value is SkySelectionResult {
  if (!isRecord(value)) return false;
  if (value.ok === false) return isFailure(value);
  const s = value.selection;
  return value.ok === true && exactKeys(value, ["ok", "selection"]) && isRecord(s) && exactKeys(s, ["context", "object", "sources"])
    && isObservationContext(s.context) && isSkyObject(s.object, s.context.atUtc) && isSources(s.sources) && hasSources(s.object, s.sources);
}
