import { rename } from "node:fs/promises";
import { JsonPlacesRepository } from "../../apps/backend/dist/modules/observing/adapters/json-places-repository.js";
const [root, point] = process.argv.slice(2);
const repository = new JsonPlacesRepository(root, async (from, to) => {
  if (point === "after") await rename(from, to);
  process.send(point);
  await new Promise(() => { setInterval(() => {}, 1000); });
});
const loaded = await repository.load();
await repository.save({ ...loaded.state, revision: loaded.state.revision + 1, places: loaded.state.places.map(p => ({ ...p, name: "Synteettinen keskeytys" })) }, loaded.token, () => true);
