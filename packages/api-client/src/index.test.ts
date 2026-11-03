import { expect, it } from "vitest";
import { createRuntimeClient } from "./index.js";
it("does not expose an invalid or secret-bearing response to the UI", async () => {
  const bridge = { getStatus: async () => ({ ok: true, status: { state: "ready" }, session: "secret" }) };
  const client = createRuntimeClient(bridge as never);
  expect(await client.getStatus()).toEqual({ ok: false, code: "UNAVAILABLE" });
});
it("normalizes a closed bridge to a public availability error", async () => {
  const client = createRuntimeClient({ getStatus: async () => { throw new Error("private path"); } });
  expect(await client.getStatus()).toEqual({ ok: false, code: "UNAVAILABLE" });
});
