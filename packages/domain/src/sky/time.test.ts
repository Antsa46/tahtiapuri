import { expect, it } from "vitest";
import { canonicalUtc, observationContext, resolveLocalTime } from "./time.js";
const observer = { latitudeDeg: 60, longitudeDeg: 25, elevationMeters: 0 };
it("rejects ambiguous timestamps, impossible calendar dates and unsupported epochs", () => {
  expect(canonicalUtc("2024-02-29T12:00:00Z")).toBe("2024-02-29T12:00:00.000Z");
  expect(canonicalUtc("2024-02-29T12:00:00.123Z")).toBe("2024-02-29T12:00:00.123Z");
  for (const s of ["2024-02-30T12:00:00Z", "2024-01-01T24:00:00Z", "2024-01-01T12:00:00", "2024-01-01T12:00:00+02:00", "1999-12-31T23:59:59Z", "2101-01-01T00:00:00Z", "2024-12-31T23:59:60Z"]) expect(() => canonicalUtc(s)).toThrow("INVALID_TIME");
});
it("resolves the Helsinki autumn fold only with an explicit, correct offset", () => {
  // IANA tzdb-2024a Europe: EU October last Sunday at 01:00 UTC.
  expect(resolveLocalTime("2024-10-27T03:30:00", "Europe/Helsinki", 180)).toBe("2024-10-27T00:30:00.000Z");
  expect(resolveLocalTime("2024-10-27T03:30:00", "Europe/Helsinki", 120)).toBe("2024-10-27T01:30:00.000Z");
  expect(() => resolveLocalTime("2024-10-27T03:30:00", "Europe/Helsinki", 0)).toThrow("INVALID_LOCAL_TIME");
});
it("rejects the nonexistent spring hour and resolves its two neighbouring times", () => {
  for (const offset of [120, 180]) expect(() => resolveLocalTime("2024-03-31T03:30:00", "Europe/Helsinki", offset)).toThrow("INVALID_LOCAL_TIME");
  expect(resolveLocalTime("2024-03-31T02:30:00", "Europe/Helsinki", 120)).toBe("2024-03-31T00:30:00.000Z");
  expect(resolveLocalTime("2024-03-31T04:30:00", "Europe/Helsinki", 180)).toBe("2024-03-31T01:30:00.000Z");
});
it("keeps the observation instant distinct from timezone display and validates observer bounds", () => {
  const input = { atUtc: "2024-03-31T01:30:00Z", observer, timeZone: "Europe/Helsinki" };
  expect(observationContext(input)).toMatchObject({ atUtc: "2024-03-31T01:30:00.000Z", localTime: "2024-03-31T04:30:00", utcOffsetMinutes: 180 });
  expect(observationContext({ ...input, timeZone: "UTC" })).toMatchObject({ localTime: "2024-03-31T01:30:00", utcOffsetMinutes: 0 });
  expect(() => observationContext({ ...input, timeZone: "../unknown" })).toThrow("INVALID_ZONE");
  for (const bad of [{ ...observer, latitudeDeg: 91 }, { ...observer, longitudeDeg: Infinity }, { ...observer, elevationMeters: NaN }, { ...observer, latitudeDeg: "60" as unknown as number }]) expect(() => observationContext({ ...input, observer: bad })).toThrow("INVALID_OBSERVER");
});

it("roundtrips supported UTC boundaries even when local calendar years are outside them", () => {
  expect(resolveLocalTime("1999-12-31T19:00:00", "America/New_York", -300)).toBe("2000-01-01T00:00:00.000Z");
  expect(resolveLocalTime("2101-01-01T13:59:59", "Pacific/Kiritimati", 840)).toBe("2100-12-31T23:59:59.000Z");
});
