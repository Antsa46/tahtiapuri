import { expect, it, vi } from "vitest";
import { createObservingClient } from "./observing.js";
it("does not expose private transport errors or malformed saved-state responses", async () => {
  const bridge = { read: async () => ({ ok: false, code: "READ_FAILED", path: "private" }), save: vi.fn(), remove: vi.fn(), activate: vi.fn() };
  expect(await createObservingClient(bridge as never).read()).toEqual({ ok: false, code: "UNAVAILABLE" });
  expect(await createObservingClient(undefined).read()).toEqual({ ok: false, code: "UNAVAILABLE" });
  expect(await createObservingClient({ ...bridge, read: async () => { throw new Error("private"); } } as never).read()).toEqual({ ok: false, code: "UNAVAILABLE" });
});
