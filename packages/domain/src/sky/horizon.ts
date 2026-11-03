import type { CompassDirection } from "./types.js";
export function geometricHorizon(altitudeDeg: number): "above" | "on" | "below" {
  if (!Number.isFinite(altitudeDeg) || Math.abs(altitudeDeg) > 90) throw new Error("INVALID_ALTITUDE");
  return altitudeDeg > 0 ? "above" : altitudeDeg < 0 ? "below" : "on";
}
export function compassDirection(azimuthDeg: number): CompassDirection {
  if (!Number.isFinite(azimuthDeg)) throw new Error("INVALID_AZIMUTH");
  return (["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const)[Math.floor((((azimuthDeg % 360) + 360) % 360 + 22.5) / 45) % 8]!;
}
