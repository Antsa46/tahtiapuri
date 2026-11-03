import { beforeAll, expect, it } from "vitest";
import { readFile, cp, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createSky } from "../../../apps/backend/src/composition/create-sky.js";
import { AstronomyCalculator } from "../../../apps/backend/src/modules/sky/adapters/astronomy-calculator.js";
import { loadLocalStarCatalog } from "../../../apps/backend/src/modules/sky/adapters/local-star-catalog.js";
import { observationContext, type StarCatalog } from "@tahtiapuri/domain";
type Reference = { sourceId: string; scenario: string; body: string; atUtc: string; timeZone: string; observer: { latitudeDeg: number; longitudeDeg: number; elevationMeters: number }; raDeg: number; decDeg: number; azimuthDeg: number; altitudeDeg: number; magnitudeV: number | null };
const reference: { tolerances: { positionDeg: number; magnitude: number }; cases: Reference[] } = JSON.parse(await readFile("tests/fixtures/sky/jpl-horizons.json", "utf8"));
let catalog: StarCatalog;
const angleDifference = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
beforeAll(async () => { catalog = (await loadLocalStarCatalog("resources/catalogs")).get(); });
for (const c of reference.cases) {
  it("independent JPL " + c.sourceId + " " + c.atUtc, () => {
    const snapshot = new AstronomyCalculator().calculate(observationContext(c), { ...catalog, stars: [] });
    const actual = snapshot.objects.find(x => x.id === c.body)!;
    expect(angleDifference(actual.equatorial.raHours * 15, c.raDeg)).toBeLessThan(reference.tolerances.positionDeg);
    expect(Math.abs(actual.equatorial.decDeg - c.decDeg)).toBeLessThan(reference.tolerances.positionDeg);
    expect(angleDifference(actual.horizontal.azimuthDeg!, c.azimuthDeg)).toBeLessThan(reference.tolerances.positionDeg);
    expect(Math.abs(actual.horizontal.altitudeDeg - c.altitudeDeg)).toBeLessThan(reference.tolerances.positionDeg);
    // Saturn's ring-inclusive Astronomy Engine magnitude is not Horizons' disc magnitude.
    if (c.body !== "Saturn" && c.magnitudeV !== null) expect(Math.abs(actual.magnitude.value! - c.magnitudeV)).toBeLessThan(reference.tolerances.magnitude);
  });
}
it("computes all 5070 stars deterministically with sources, units and observation time", async () => {
  const service = await createSky("resources/catalogs"), context = { atUtc: "2024-06-21T00:00:00Z", timeZone: "Europe/Helsinki", observer: { latitudeDeg: 70, longitudeDeg: 20, elevationMeters: 0 } };
  const a = service.calculate(context), b = service.calculate(context);
  expect(a).toEqual(b); expect(a.objects).toHaveLength(5079);
  for (const object of a.objects) {
    expect(a.sources.some(s => s.id === object.sourceId)).toBe(true);
    expect(a.sources.some(s => s.id === object.magnitude.sourceId)).toBe(true);
    expect(object.atUtc).toBe(a.context.atUtc);
    expect(object.equatorial.raHours).toBeGreaterThanOrEqual(0); expect(object.equatorial.raHours).toBeLessThan(24);
    expect(Math.abs(object.equatorial.decDeg)).toBeLessThanOrEqual(90);
    expect(Math.abs(object.horizontal.altitudeDeg)).toBeLessThanOrEqual(90);
  }
  expect(a.objects.find(x => x.id === "Sun")!.horizontal.horizon).toBe("above");
  const winter = service.calculate({ ...context, atUtc: "2024-12-21T12:00:00Z" });
  expect(winter.objects.find(x => x.id === "Sun")!.horizontal.horizon).toBe("below");
  const utcDisplay = service.calculate({ ...context, timeZone: "UTC" });
  expect(utcDisplay.objects).toEqual(a.objects);
});
it("distinguishes lunar phase longitude from physical phase angle at new and full moon", () => {
  const calculator = new AstronomyCalculator(), empty = { ...catalog, stars: [] };
  const input = { timeZone: "UTC", observer: { latitudeDeg: 0, longitudeDeg: 0, elevationMeters: 0 } };
  const full = calculator.calculate(observationContext({ ...input, atUtc: "2024-03-25T07:00:00Z" }), empty).moon;
  const fresh = calculator.calculate(observationContext({ ...input, atUtc: "2024-04-08T18:21:00Z" }), empty).moon;
  expect(Math.abs(full.phaseLongitudeDeg - 180)).toBeLessThan(1); expect(full.phaseAngleDeg).toBeLessThan(2); expect(full.illuminatedFraction).toBeGreaterThan(0.999);
  expect(angleDifference(fresh.phaseLongitudeDeg, 0)).toBeLessThan(1); expect(fresh.phaseAngleDeg).toBeGreaterThan(178); expect(fresh.illuminatedFraction).toBeLessThan(0.001);
});
it("matches independent ERFA precession/nutation and horizon geometry for synthetic stellar directions", async () => {
  const f = JSON.parse(await readFile("tests/fixtures/sky/erfa.json", "utf8")) as { matrix: number[][]; gastRadians: number; hourAngleRadians: number; declinationRadians: number; latitudeRadians: number; azimuthRadians: number; altitudeRadians: number; toleranceDeg: number; dateUtc: string };
  const ra = f.gastRadians - f.hourAngleRadians, dec = f.declinationRadians, toDegrees = 180 / Math.PI;
  const ofDate = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  const j2000 = [0, 1, 2].map(j => ofDate.reduce((sum, value, i) => sum + f.matrix[i]![j]! * value, 0)) as [number, number, number];
  const star = { id: "synthetic-erfa", name: "Synthetic ERFA", raHoursJ2000: 0, decDegJ2000: 0, magnitudeV: 1, positionPc: j2000, velocityPcPerYear: [0, 0, 0] as const, variable: false };
  const snapshot = new AstronomyCalculator().calculate(observationContext({ atUtc: f.dateUtc, timeZone: "UTC", observer: { latitudeDeg: f.latitudeRadians * toDegrees, longitudeDeg: 0, elevationMeters: 0 } }), { ...catalog, stars: [star] });
  const actual = snapshot.objects.find(x => x.id === star.id)!;
  expect(angleDifference(actual.equatorial.raHours * 15, ra * toDegrees)).toBeLessThan(f.toleranceDeg);
  expect(Math.abs(actual.equatorial.decDeg - dec * toDegrees)).toBeLessThan(f.toleranceDeg);
  expect(angleDifference(actual.horizontal.azimuthDeg!, f.azimuthRadians * toDegrees)).toBeLessThan(f.toleranceDeg);
  expect(Math.abs(actual.horizontal.altitudeDeg - f.altitudeRadians * toDegrees)).toBeLessThan(f.toleranceDeg);
});
it("rejects a changed catalogue even if its manifest hash is recomputed", async () => {
  await mkdir(".artifacts/tests", { recursive: true });
  const directory = await mkdtemp(".artifacts/tests/sky-catalog-");
  try {
    await cp("resources/catalogs", directory, { recursive: true });
    const file = join(directory, "stars.json"), m = join(directory, "manifest.json");
    const data = JSON.parse(await readFile(file, "utf8")); data.stars[0][4] = 0;
    const raw = JSON.stringify(data); await writeFile(file, raw);
    const manifest = JSON.parse(await readFile(m, "utf8")); manifest.sha256 = createHash("sha256").update(raw).digest("hex");
    await writeFile(m, JSON.stringify(manifest));
    await expect(loadLocalStarCatalog(directory)).rejects.toThrow("CATALOG_INVALID");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("propagates source Cartesian proper motion before the independent ERFA frame rotation", async () => {
  const f = JSON.parse(await readFile("tests/fixtures/sky/erfa.json", "utf8")) as { matrix: number[][]; dateUtc: string; toleranceDeg: number };
  // J2000 -> 2006 is six Julian years. A synthetic transverse velocity makes
  // omission of proper motion a 0.34-degree error, larger than the tolerance.
  const evolved = [1, 0.006, 0], transformed = f.matrix.map(row => row.reduce((s, v, i) => s + v * evolved[i]!, 0));
  const expectedRa = ((Math.atan2(transformed[1]!, transformed[0]!) * 180 / Math.PI) + 360) % 360;
  const expectedDec = Math.atan2(transformed[2]!, Math.hypot(transformed[0]!, transformed[1]!)) * 180 / Math.PI;
  const star = { id: "synthetic-motion", name: "Synthetic motion", raHoursJ2000: 0, decDegJ2000: 0, magnitudeV: 1, positionPc: [1, 0, 0] as const, velocityPcPerYear: [0, 0.001, 0] as const, variable: false };
  const context = observationContext({ atUtc: f.dateUtc, timeZone: "UTC", observer: { latitudeDeg: 0, longitudeDeg: 0, elevationMeters: 0 } });
  const actual = new AstronomyCalculator().calculate(context, { ...catalog, stars: [star] }).objects.find(x => x.id === star.id)!;
  expect(angleDifference(actual.equatorial.raHours * 15, expectedRa)).toBeLessThan(f.toleranceDeg);
  expect(Math.abs(actual.equatorial.decDeg - expectedDec)).toBeLessThan(f.toleranceDeg);
});
