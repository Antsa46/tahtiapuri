import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
const profile = JSON.parse(await readFile(join(root, "resources/models/qwen3-4b.json"), "utf8"));
const directory = join(root, ".local/models");
await mkdir(directory, { recursive: true });
async function checksum(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
const target = join(directory, profile.file);
if (!(await stat(target).catch(() => null))) {
  const response = await fetch(profile.downloadUrl, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok || !response.body) throw new Error("Model download failed: " + response.status);
  let bytes = 0, last = 0;
  const hash = createHash("sha256");
  const source = Readable.fromWeb(response.body);
  source.on("data", chunk => {
    hash.update(chunk); bytes += chunk.length;
    if (Date.now() - last > 10_000) { console.log(Math.round(bytes / profile.bytes * 100) + "%"); last = Date.now(); }
  });
  await pipeline(source, createWriteStream(target + ".part", { flags: "wx" }));
  if (bytes !== profile.bytes || hash.digest("hex") !== profile.sha256) throw new Error("Model checksum mismatch.");
  await rename(target + ".part", target);
}
if ((await stat(target)).size !== profile.bytes || await checksum(target) !== profile.sha256) throw new Error("Model verification failed.");
const license = await fetch(profile.licenseUrl);
if (!license.ok) throw new Error("License download failed.");
const text = await license.text();
if (createHash("sha256").update(text).digest("hex") !== profile.licenseSha256) throw new Error("License checksum mismatch.");
await writeFile(join(directory, profile.id + ".LICENSE"), text);
console.log(JSON.stringify({ model: profile.id, sha256: profile.sha256, bytes: profile.bytes, verified: true }));
