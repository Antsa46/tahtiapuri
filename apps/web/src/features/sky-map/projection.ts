import type { SkyObject } from "@tahtiapuri/validation/sky";
export const MAP_SIZE = 800;
export const MAP_CENTER = MAP_SIZE / 2;
export const MAP_RADIUS = 346;
export type MapPoint = { id: string; x: number; y: number; radius: number; object: SkyObject };
/** Zenith-centred equidistant sky view: north up, east left when looking up. */
export function projectHorizontal(altitudeDeg: number, azimuthDeg: number | null): { x: number; y: number } | null {
  if (!Number.isFinite(altitudeDeg) || altitudeDeg < 0 || altitudeDeg > 90) return null;
  if (azimuthDeg === null) return altitudeDeg > 90 - 1e-7 ? { x: MAP_CENTER, y: MAP_CENTER } : null;
  if (!Number.isFinite(azimuthDeg) || azimuthDeg < 0 || azimuthDeg >= 360) return null;
  const radius = (90 - altitudeDeg) / 90 * MAP_RADIUS, angle = azimuthDeg * Math.PI / 180;
  return { x: MAP_CENTER - radius * Math.sin(angle), y: MAP_CENTER - radius * Math.cos(angle) };
}
export function mapPoints(objects: readonly SkyObject[]): MapPoint[] {
  return objects.flatMap(object => {
    const point = projectHorizontal(object.horizontal.altitudeDeg, object.horizontal.azimuthDeg);
    if (!point) return [];
    const radius = object.kind === "star" ? Math.max(0.7, 2.7 - (object.magnitude.value ?? 6) * 0.31)
      : object.kind === "sun" ? 7 : object.kind === "moon" ? 6 : 3.8;
    return [{ ...point, id: object.id, radius, object }];
  });
}
export function pickMapPoint(points: readonly MapPoint[], x: number, y: number, tolerance: number): MapPoint | undefined {
  let closest: MapPoint | undefined, distance = Infinity;
  for (const point of points) {
    const d = Math.hypot(point.x - x, point.y - y);
    if (d <= Math.max(tolerance, point.radius) && d < distance) { closest = point; distance = d; }
  }
  return closest;
}
