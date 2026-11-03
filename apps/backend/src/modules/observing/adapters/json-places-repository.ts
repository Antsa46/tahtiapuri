import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve, relative } from "node:path";
import type { PlacesState } from "@tahtiapuri/domain";
import { exactKeys, isRecord } from "@tahtiapuri/validation/public";
import { isPlacesState } from "@tahtiapuri/validation/observing";
import { PlacesStorageError, type PlacesRepository, type LoadedPlaces } from "../ports/places-repository.js";
const MAX_BYTES = 32_768;
const digest = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const empty = (): LoadedPlaces => ({ state: { revision: 0, places: [], activePlaceId: null }, token: null });
export class JsonPlacesRepository implements PlacesRepository {
  private readonly directory: string;
  constructor(dataRoot: string, private readonly replaceFile: typeof rename = rename) { this.directory = resolve(dataRoot, "observing"); }
  private async root(): Promise<string> {
    try { await mkdir(this.directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
    const root = await realpath(this.directory);
    if (relative(this.directory, root) !== "") throw new Error();
    return root;
  }
  async load(): Promise<LoadedPlaces> {
    try {
      const path = join(await this.root(), "places.json");
      let before;
      try { before = await lstat(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty(); throw error; }
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES) throw new Error();
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > MAX_BYTES) throw new Error();
        const buffer = Buffer.alloc(MAX_BYTES + 1); let total = 0;
        while (total < buffer.length) {
          const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
          if (!bytesRead) break; total += bytesRead;
        }
        if (total > MAX_BYTES) throw new Error();
        const raw = buffer.subarray(0, total), value: unknown = JSON.parse(raw.toString("utf8"));
        if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "state", "sha256"]) || value.schemaVersion !== 1
          || !isPlacesState(value.state) || value.sha256 !== digest(JSON.stringify(value.state))) throw new Error();
        return { state: value.state, token: digest(raw) };
      } finally { await file.close(); }
    } catch { throw new PlacesStorageError("READ_FAILED"); }
  }
  async save(state: PlacesState, expectedToken: string | null, canCommit: () => boolean): Promise<void> {
    let temporary: string | undefined;
    try {
      if (!isPlacesState(state)) throw new Error();
      const previous = await this.load();
      if (previous.token !== expectedToken) throw new PlacesStorageError("CONFLICT");
      const raw = JSON.stringify({ schemaVersion: 1, state, sha256: digest(JSON.stringify(state)) }) + "\n";
      if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error();
      const root = await this.root();
      temporary = join(root, "places-" + randomUUID() + ".tmp");
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(raw, "utf8"); await file.sync(); } finally { await file.close(); }
      // Keep the last acknowledged file untouched until the single commit point.
      if ((await this.load()).token !== expectedToken) throw new PlacesStorageError("CONFLICT");
      if (!canCommit()) throw new PlacesStorageError("UNAVAILABLE");
      await this.replaceFile(temporary, join(root, "places.json"));
      temporary = undefined;
    } catch (error) {
      if (error instanceof PlacesStorageError) throw error;
      throw new PlacesStorageError("SAVE_FAILED");
    } finally { if (temporary) await unlink(temporary).catch(() => {}); }
  }
}
