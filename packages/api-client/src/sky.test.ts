import { expect, it, vi } from "vitest";
import { createSkyClient } from "./sky.js";
const observation = { atUtc: "2024-03-31T00:30:00.000Z", timeZone: "Europe/Helsinki", observer: { latitudeDeg: 60, longitudeDeg: 25, elevationMeters: 0 } };
it("rejects malformed or secret-bearing responses and normalizes transport errors", async () => {
  const client = createSkyClient({ snapshot: async () => ({ ok: false, code: "CATALOG_UNAVAILABLE", path: "private" } as never), select: async () => { throw new Error("private path"); } });
  expect(await client.snapshot(observation)).toEqual({ ok: false, code: "UNAVAILABLE" });
  expect(await client.select({ observation, objectId: "Sun" })).toEqual({ ok: false, code: "UNAVAILABLE" });
  expect(await createSkyClient(undefined).snapshot(observation)).toEqual({ ok: false, code: "UNAVAILABLE" });
});
it("does not forward extra request keys or URL-shaped object ids", async () => {
  const snapshot = vi.fn(), select = vi.fn(), client = createSkyClient({ snapshot, select });
  expect(await client.snapshot({ ...observation, catalogPath: "outside" } as never)).toEqual({ ok: false, code: "INVALID_INPUT" });
  expect(await client.select({ observation, objectId: "https://invalid.test/" })).toEqual({ ok: false, code: "INVALID_INPUT" });
  expect(snapshot).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
});
