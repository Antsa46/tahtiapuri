export type Observer = { latitudeDeg: number; longitudeDeg: number; elevationMeters: number };
export type ObservationRequest = { atUtc: string; timeZone: string; observer: Observer };
export type ObservationContext = ObservationRequest & { localTime: string; utcOffsetMinutes: number };
export type SolarBodyId = "Sun" | "Moon" | "Mercury" | "Venus" | "Mars" | "Jupiter" | "Saturn" | "Uranus" | "Neptune";
export const SOLAR_BODIES: readonly SolarBodyId[] = ["Sun", "Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"];
export type CompassDirection = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
export type StarRecord = { id: string; name: string; raHoursJ2000: number; decDegJ2000: number; magnitudeV: number; positionPc: readonly [number, number, number]; velocityPcPerYear: readonly [number, number, number]; variable: boolean };
export type StarCatalog = { id: "hyg-v41-naked-eye-v1"; sourceUrl: string; sourceRevision: string; sha256: string; stars: readonly StarRecord[] };
export type SkyObject = {
  id: string; name: string; kind: "sun" | "moon" | "planet" | "star"; atUtc: string;
  equatorial: { raHours: number; decDeg: number; frame: "true-equator-of-date"; origin: "topocentric" | "stellar-direction" };
  horizontal: { altitudeDeg: number; azimuthDeg: number | null; direction: CompassDirection | null; refraction: "none"; horizon: "above" | "on" | "below" };
  magnitude: { value: number | null; kind: "geocentric-visual-model" | "catalog-v"; sourceId: string };
  sourceId: string;
};
export type SkySnapshot = {
  context: ObservationContext;
  objects: readonly SkyObject[];
  moon: { atUtc: string; sourceId: string; phaseLongitudeDeg: number; phaseAngleDeg: number; illuminatedFraction: number };
  sources: readonly { id: string; version: string; url: string; frame: string; corrections: readonly string[] }[];
};
