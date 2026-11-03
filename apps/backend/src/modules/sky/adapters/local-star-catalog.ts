import { readFile, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { StarCatalog, StarRecord } from "@tahtiapuri/domain";
import { exactKeys, isRecord } from "@tahtiapuri/validation/public";
import type { StarCatalogPort } from "../ports/sky-calculator.js";
const columns = ["hygId", "name", "raHoursJ2000", "decDegJ2000", "magnitudeV", "xPc", "yPc", "zPc", "vxPcPerYear", "vyPcPerYear", "vzPcPerYear", "variable"];
const approvedSha256 = "076fce99a809190350e467f5a953658c8378ecbef47fbba79c7756ad3c4426a3";
const sourceSha256 = "d9f69fd86bbf90a4e4d52b4c5c53eacfa6dfc0bfdef85bfd94f095e0bebe4ebd";
const revision = "c7f7f883fe678cc7680169a50ccd7dcc49b060ce";
const sourceUrl = "https://raw.githubusercontent.com/astronexus/HYG-Database/" + revision + "/hyg/CURRENT/hygdata_v41.csv";
export async function loadLocalStarCatalog(directory: string): Promise<StarCatalogPort> {
  try {
    const mpath = join(directory, "manifest.json"), path = join(directory, "stars.json");
    for (const [file, limit] of [[mpath, 8192], [path, 2_000_000]] as const) {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error();
    }
    const m: unknown = JSON.parse(await readFile(mpath, "utf8")), raw = await readFile(path);
    if (!isRecord(m) || m.id !== "hyg-v41-naked-eye-v1" || m.sourceVersion !== "4.1" || m.sourceRevision !== revision
      || m.sourceUrl !== sourceUrl || m.license !== "CC-BY-SA-4.0" || m.epoch !== "J2000.0" || m.file !== "stars.json"
      || m.sha256 !== approvedSha256 || m.sourceSha256 !== sourceSha256 || createHash("sha256").update(raw).digest("hex") !== m.sha256) throw new Error();
    const data: unknown = JSON.parse(raw.toString("utf8"));
    if (!isRecord(data) || !exactKeys(data, ["schemaVersion", "id", "columns", "stars"]) || data.schemaVersion !== 1 || data.id !== m.id
      || !Array.isArray(data.columns) || data.columns.join("|") !== columns.join("|") || !Array.isArray(data.stars)
      || data.stars.length !== 5070 || data.stars.length !== m.count) throw new Error();
    const ids = new Set<number>();
    const stars: StarRecord[] = data.stars.map((row: unknown) => {
      if (!Array.isArray(row) || row.length !== 12 || !Number.isSafeInteger(row[0]) || row[0] <= 0 || ids.has(row[0])
        || typeof row[1] !== "string" || !row[1].length || row[1].length > 128 || /[\u0000-\u001f]/.test(row[1])
        || !row.slice(2, 11).every(v => typeof v === "number" && Number.isFinite(v)) || typeof row[11] !== "boolean"
        || row[2] < 0 || row[2] >= 24 || Math.abs(row[3]) > 90 || row[4] < -2 || row[4] > 6
        || Math.hypot(row[5], row[6], row[7]) < 0.01 || Math.hypot(row[8], row[9], row[10]) / Math.hypot(row[5], row[6], row[7]) > 0.001) throw new Error();
      ids.add(row[0]);
      return Object.freeze({ id: "hyg-" + row[0], name: row[1], raHoursJ2000: row[2], decDegJ2000: row[3], magnitudeV: row[4],
        positionPc: Object.freeze([row[5], row[6], row[7]]) as readonly [number, number, number],
        velocityPcPerYear: Object.freeze([row[8], row[9], row[10]]) as readonly [number, number, number], variable: row[11] });
    });
    const catalog: StarCatalog = Object.freeze({ id: "hyg-v41-naked-eye-v1", sourceUrl, sourceRevision: revision, sha256: m.sha256, stars: Object.freeze(stars) });
    return { get: () => catalog };
  } catch { throw new Error("CATALOG_INVALID"); }
}
