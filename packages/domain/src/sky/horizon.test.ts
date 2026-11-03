import { expect, it } from "vitest";
import { compassDirection, geometricHorizon } from "./horizon.js";
it("uses north-zero east-positive azimuth with stable wrap and sector boundaries", () => {
  expect([0, 45, 90, 135, 180, 225, 270, 315, 360, -45].map(compassDirection)).toEqual(["N", "NE", "E", "SE", "S", "SW", "W", "NW", "N", "NW"]);
  expect(compassDirection(22.499)).toBe("N"); expect(compassDirection(22.5)).toBe("NE");
});
it("classifies only geometric centre height and does not claim visibility", () => {
  expect([-0.01, 0, 0.01].map(geometricHorizon)).toEqual(["below", "on", "above"]);
  expect(() => geometricHorizon(NaN)).toThrow(); expect(() => geometricHorizon(91)).toThrow();
});
