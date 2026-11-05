import { beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { DevelopmentClient } from "./development-client.js";

const bootstrap = vi.hoisted(() => ({ lstat: vi.fn(), readFile: vi.fn(), createConnection: vi.fn() }));
vi.mock("node:fs/promises", () => ({ lstat: bootstrap.lstat, readFile: bootstrap.readFile }));
vi.mock("node:net", () => ({ createConnection: bootstrap.createConnection }));
const description = { protocol: 1, pipe: "\\\\.\\pipe\\tahtiapuri-mcp-" + "a".repeat(32), token: "b".repeat(64) };
const denied = { ok: false, code: "INVALID_INPUT" };
beforeEach(() => {
  vi.clearAllMocks();
  bootstrap.lstat.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false, size: 200 });
  bootstrap.readFile.mockResolvedValue(JSON.stringify(description));
});
async function fixture() {
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false, readableEnded: false, writableEnded: false, writableLength: 0,
    setEncoding: vi.fn(), write: vi.fn((_frame: string) => true),
    destroy: vi.fn(function (this: EventEmitter & { destroyed: boolean }) {
      if (!this.destroyed) { this.destroyed = true; this.emit("close"); }
    }),
  });
  bootstrap.createConnection.mockReturnValue(socket);
  const client = new DevelopmentClient(); const ready = client.connect("synthetic-description.json");
  await Promise.resolve(); await Promise.resolve();
  expect(bootstrap.createConnection).toHaveBeenCalledWith(description.pipe);
  socket.emit("connect"); expect(JSON.parse(socket.write.mock.calls[0]![0])).toEqual({ token: description.token });
  return { socket, client, ready };
}
it("transfers trailing authenticated response frames and partial bytes", async () => {
  const f = await fixture();
  f.socket.emit("data", '{"connected":true}\n' + JSON.stringify({ id: "unknown", result: denied }) + '\n{"id":');
  await f.ready;
  const pending = f.client.request("status", null);
  const command = JSON.parse(f.socket.write.mock.calls[1]![0]) as { id: string };
  f.socket.emit("data", JSON.stringify(command.id) + ',"result":' + JSON.stringify(denied) + '}\n');
  expect(await pending).toEqual(denied); f.client.close();
});
it.each(["{}\n", "broken\n", '{"connected":true}\n'])("fails closed on a malformed frame following authentication", async trailing => {
  const f = await fixture(); f.socket.emit("data", '{"connected":true}\n' + trailing); await f.ready;
  expect(await f.client.request("status", null)).toEqual({ ok: false, code: "ENGINE_UNAVAILABLE" });
  expect(f.socket.destroyed).toBe(true);
});
it("keeps the old client unavailable after the application disconnects", async () => {
  const f = await fixture(); f.socket.emit("data", '{"connected":true}\n'); await f.ready;
  const pending = f.client.request("status", null); f.socket.emit("end");
  expect(await pending).toEqual({ ok: false, code: "ENGINE_UNAVAILABLE" });
  await f.client.connect("new-description.json"); expect(bootstrap.createConnection).toHaveBeenCalledTimes(1);
});
it("does not open a socket if closed while reading the descriptor", async () => {
  let release!: (value: string) => void;
  bootstrap.readFile.mockReturnValue(new Promise<string>(resolve => { release = resolve; }));
  const client = new DevelopmentClient(); const ready = client.connect("synthetic-description.json");
  await Promise.resolve(); client.close(); release(JSON.stringify(description)); await ready;
  expect(bootstrap.createConnection).not.toHaveBeenCalled();
});
