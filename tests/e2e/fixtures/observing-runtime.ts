import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { access, writeFile } from "node:fs/promises";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
export async function observingFixture(mode: "save-fail" | "sky-hold") {
  const [{ createBackend }, { PlacesService }, { JsonPlacesRepository }, { createSky }, { SkyQueries }] = await Promise.all([
    load("apps/backend/dist/composition/create-backend.js"), load("apps/backend/dist/modules/observing/application/places-service.js"),
    load("apps/backend/dist/modules/observing/adapters/json-places-repository.js"), load("apps/backend/dist/composition/create-sky.js"), load("apps/backend/dist/modules/sky/application/sky-queries.js"),
  ]);
  const port = (process as NodeJS.Process & { parentPort: { postMessage(m: unknown): void; on(event: "message", listener: (e: { data: unknown }) => void): void } }).parentPort;
  class HeldSky extends SkyQueries {
    constructor(service: unknown) { super(service); }
    async snapshot(input: unknown) {
      const result = await super.snapshot(input);
      if (mode === "sky-hold" && (input as { atUtc?: string })?.atUtc === "2024-03-31T01:30:00.000Z") {
        await writeFile("sky-held", "synthetic");
        const limit = Date.now() + 2000;
        for (;;) {
          try { await access("release-sky"); break; } catch { if (Date.now() >= limit) throw new Error("Synthetic barrier timed out"); }
          await new Promise<void>(resolve => setTimeout(resolve, 10));
        }
      }
      return result;
    }
  }
  const repository = mode === "save-fail" ? new JsonPlacesRepository(process.cwd(), async () => { throw new Error("synthetic rename failure"); }) : new JsonPlacesRepository(process.cwd());
  const endpoint = createBackend({ observing: new PlacesService(repository), sky: new HeldSky(createSky(resolve(root, "resources/catalogs"))), send: (m: unknown) => port.postMessage(m), stop: () => process.exit(0), now: () => Date.now() });
  port.on("message", event => { endpoint.receive(event.data); });
}
