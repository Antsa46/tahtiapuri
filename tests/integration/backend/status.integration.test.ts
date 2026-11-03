import { describe, expect, it } from "vitest";
import { createBackend } from "../../../apps/backend/src/composition/create-backend.js";
const session = "a".repeat(64);
const request = (extra: Record<string, unknown> = {}) => ({
  type: "request", protocol: 1, session, id: "00000000-0000-4000-8000-000000000001",
  operation: "runtime.status", expiresAtUnixMs: 2000, ...extra,
});
function setup() {
  const messages: unknown[] = []; let stopped = false;
  const endpoint = createBackend({ send: message => messages.push(message), stop: () => { stopped = true; }, now: () => 1000 });
  return { endpoint, messages, stopped: () => stopped };
}
describe("backend status boundary", () => {
  it("requires initialization and returns the composed application status", () => {
    const s = setup();
    expect(s.endpoint.receive(request())).toBe(false);
    expect(s.endpoint.receive({ type: "initialize", protocol: 1, session })).toBe(true);
    expect(s.endpoint.receive(request())).toBe(true);
    expect(s.messages.at(-1)).toMatchObject({ operation: "runtime.status", result: { state: "ready", model: "not-loaded" } });
  });
  it.each([
    { session: "b".repeat(64) }, { protocol: 2 }, { operation: "shell.exec" },
    { expiresAtUnixMs: 999 }, { expiresAtUnixMs: 10_000 }, { role: "main" }, { id: "bad" },
  ])("rejects invalid authority or messages: %j", extra => {
    const s = setup(); s.endpoint.receive({ type: "initialize", protocol: 1, session });
    expect(s.endpoint.receive(request(extra))).toBe(false);
    expect(s.messages).toHaveLength(1);
    expect(s.stopped()).toBe(false);
  });
  it("rejects duplicate IDs, reinitialization and work after shutdown", () => {
    const s = setup(); s.endpoint.receive({ type: "initialize", protocol: 1, session });
    expect(s.endpoint.receive(request())).toBe(true);
    expect(s.endpoint.receive(request())).toBe(false);
    expect(s.endpoint.receive({ type: "initialize", protocol: 1, session })).toBe(false);
    expect(s.endpoint.receive(request({ operation: "runtime.shutdown", id: "00000000-0000-4000-8000-000000000002" }))).toBe(true);
    expect(s.stopped()).toBe(true);
    expect(s.endpoint.receive(request())).toBe(false);
  });
});
