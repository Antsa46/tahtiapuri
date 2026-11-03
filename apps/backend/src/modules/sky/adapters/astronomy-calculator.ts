import { AstroTime, Body, Equator, EquatorFromVector, Horizon, Illumination, MoonPhase, Observer as EngineObserver, RotateVector, Rotation_EQJ_EQD, Vector } from "astronomy-engine";
import { compassDirection, geometricHorizon, SOLAR_BODIES, type ObservationContext, type SkyObject, type SkySnapshot, type StarCatalog } from "@tahtiapuri/domain";
import type { SkyCalculator } from "../ports/sky-calculator.js";
const ENGINE = "astronomy-engine-2.1.19";
const STELLAR = "hyg-v41+astronomy-engine-2.1.19";
const names = { Sun: "Aurinko", Moon: "Kuu", Mercury: "Merkurius", Venus: "Venus", Mars: "Mars", Jupiter: "Jupiter", Saturn: "Saturnus", Uranus: "Uranus", Neptune: "Neptunus" };
export class AstronomyCalculator implements SkyCalculator {
  calculate(context: ObservationContext, catalog: StarCatalog): SkySnapshot {
    const date = new Date(context.atUtc), time = new AstroTime(date);
    const site = new EngineObserver(context.observer.latitudeDeg, context.observer.longitudeDeg, context.observer.elevationMeters);
    const objects: SkyObject[] = [];
    const horizontal = (ra: number, dec: number): SkyObject["horizontal"] => {
      const h = Horizon(time, site, ra, dec);
      const azimuthDeg = Math.abs(Math.abs(h.altitude) - 90) < 1e-7 ? null : ((h.azimuth % 360) + 360) % 360;
      return { altitudeDeg: h.altitude, azimuthDeg, direction: azimuthDeg === null ? null : compassDirection(azimuthDeg), refraction: "none", horizon: geometricHorizon(h.altitude) };
    };
    for (const id of SOLAR_BODIES) {
      const body = Body[id], equ = Equator(body, time, site, true, true), light = Illumination(body, time);
      objects.push({ id, name: names[id], kind: id === "Sun" ? "sun" : id === "Moon" ? "moon" : "planet", atUtc: context.atUtc,
        equatorial: { raHours: equ.ra, decDeg: equ.dec, frame: "true-equator-of-date", origin: "topocentric" },
        horizontal: horizontal(equ.ra, equ.dec),
        magnitude: { value: Number.isFinite(light.mag) ? light.mag : null, kind: "geocentric-visual-model", sourceId: ENGINE }, sourceId: ENGINE });
    }
    const rotation = Rotation_EQJ_EQD(time);
    const years = time.tt / 365.25;
    for (const star of catalog.stars) {
      const p = star.positionPc.map((value, axis) => value + years * star.velocityPcPerYear[axis]!);
      const length = Math.hypot(...p);
      const direction = new Vector(p[0]! / length, p[1]! / length, p[2]! / length, time);
      const equ = EquatorFromVector(RotateVector(rotation, direction));
      objects.push({ id: star.id, name: star.name, kind: "star", atUtc: context.atUtc,
        equatorial: { raHours: equ.ra, decDeg: equ.dec, frame: "true-equator-of-date", origin: "stellar-direction" },
        horizontal: horizontal(equ.ra, equ.dec),
        magnitude: { value: star.magnitudeV, kind: "catalog-v", sourceId: catalog.id }, sourceId: STELLAR });
    }
    const moon = Illumination(Body.Moon, time);
    return { context, objects, moon: { atUtc: context.atUtc, sourceId: ENGINE, phaseLongitudeDeg: MoonPhase(time), phaseAngleDeg: moon.phase_angle, illuminatedFraction: moon.phase_fraction }, sources: [
      { id: ENGINE, version: "2.1.19", url: "https://github.com/cosinekitty/astronomy/tree/v2.1.19/source/js", frame: "true-equator-of-date", corrections: ["topocentric parallax", "light travel time", "aberration", "precession", "nutation", "no atmospheric refraction; magnitudes geocentric and unextincted; Saturn magnitude includes ring tilt"] },
      { id: catalog.id, version: "4.1", url: catalog.sourceUrl, frame: "J2000.0", corrections: ["catalogue V magnitudes, including variable stars; not a brightness forecast"] },
      { id: STELLAR, version: "4.1/2.1.19", url: catalog.sourceUrl, frame: "true-equator-of-date", corrections: ["J2000 Cartesian position + constant velocity", "precession", "nutation", "no annual aberration", "no stellar parallax", "no atmospheric refraction"] },
    ] };
  }
}
