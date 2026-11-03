import { expect, it } from "vitest";
import { projectHorizontal, MAP_CENTER as C, MAP_RADIUS as R, pickMapPoint, type MapPoint } from "./projection.js";
it.each([[0, C, C - R], [90, C - R, C], [180, C, C + R], [270, C + R, C]])("projects sky azimuth %s north-up and east-left", (azimuth, x, y) => {
  const point = projectHorizontal(0, azimuth)!;
  expect(point.x).toBeCloseTo(x, 8); expect(point.y).toBeCloseTo(y, 8);
});
it("preserves radial altitude scale and places a directionless zenith at the centre", () => {
  expect(projectHorizontal(90, null)).toEqual({ x: C, y: C });
  expect(projectHorizontal(60, 0)!.y).toBeCloseTo(C - R / 3, 8);
  expect(projectHorizontal(30, 0)!.y).toBeCloseTo(C - R * 2 / 3, 8);
});
it.each([[-1e-9, 30], [-0.01, 30], [-90, null], [NaN, 0], [91, 0], [20, null], [10, 360], [10, NaN]])("does not plot below-horizon or invalid coordinates %s/%s", (altitude, azimuth) => {
  expect(projectHorizontal(altitude!, azimuth!)).toBeNull();
});
it("selects only the nearest actual point within the target radius", () => {
  const points = [{ id: "a", x: 100, y: 100, radius: 1 }, { id: "b", x: 110, y: 100, radius: 1 }] as MapPoint[];
  expect(pickMapPoint(points, 109, 100, 12)?.id).toBe("b");
  expect(pickMapPoint(points, 50, 50, 12)).toBeUndefined();
});
