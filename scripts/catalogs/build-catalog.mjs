import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = await readFile(join(root, ".local/catalog-sources/hyg-v41.csv"));
const sourceSha256 = createHash("sha256").update(source).digest("hex");
if (sourceSha256 !== "d9f69fd86bbf90a4e4d52b4c5c53eacfa6dfc0bfdef85bfd94f095e0bebe4ebd") throw new Error("Unapproved catalogue source.");
function csv(line) {
  const fields = []; let field = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (quoted && line[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (c === "," && !quoted) { fields.push(field); field = ""; } else field += c;
  }
  if (quoted) throw new Error("Invalid CSV source."); fields.push(field); return fields;
}
const lines = source.toString("utf8").replace(/^\uFEFF/, "").trimEnd().split(/\r?\n/);
const columns = csv(lines.shift());
const stars = [];
for (const line of lines) {
  const fields = csv(line);
  if (fields.length !== columns.length) throw new Error("Invalid source row.");
  const row = Object.fromEntries(columns.map((column, i) => [column, fields[i]]));
  if (row.id === "0" || !row.mag || Number(row.mag) > 6) continue;
  stars.push([Number(row.id), row.proper || row.bf || (row.hip ? "HIP " + row.hip : "HYG " + row.id),
    ...["ra", "dec", "mag", "x", "y", "z", "vx", "vy", "vz"].map(k => {
      if (row[k] === "" || !Number.isFinite(Number(row[k]))) throw new Error("Missing catalogue value."); return Number(row[k]);
    }), Boolean(row.var)]);
}
stars.sort((a, b) => a[0] - b[0]);
if (stars.length !== 5070 || new Set(stars.map(s => s[0])).size !== stars.length) throw new Error("Unexpected catalogue selection.");
const data = JSON.stringify({ schemaVersion: 1, id: "hyg-v41-naked-eye-v1",
  columns: ["hygId", "name", "raHoursJ2000", "decDegJ2000", "magnitudeV", "xPc", "yPc", "zPc", "vxPcPerYear", "vyPcPerYear", "vzPcPerYear", "variable"], stars }) + "\n";
const destination = join(root, "resources/catalogs");
const manifest = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"));
manifest.sha256 = createHash("sha256").update(data).digest("hex");
await writeFile(join(destination, "stars.json"), data);
await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ stars: stars.length, sha256: manifest.sha256 }));
