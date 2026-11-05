import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import { ConnectedDevelopmentClient } from "./connected-development-client.js";

const unavailable = { ok: false, code: "ENGINE_UNAVAILABLE" };
const denied = { ok: false, code: "INVALID_INPUT" };
function fixture() {
  const stream = Object.assign(new EventEmitter(), {
    destroyed: false, readableEnded: false, writableEnded: false, writableLength: 0,
    setEncoding: vi.fn(), write: vi.fn((_frame: string) => true),
    destroy: vi.fn(function (this: { destroyed: boolean }) { this.destroyed = true; }),
  });
  const client = new ConnectedDevelopmentClient(stream as unknown as Duplex);
  const command = (index = 0) => JSON.parse(stream.write.mock.calls[index]![0]) as { id: string };
  const reply = (index = 0, value: unknown = denied) => JSON.stringify({ id: command(index).id, result: value }) + "\n";
  return { stream, client, command, reply };
}
afterEach(() => vi.useRealTimers());

it("matches out-of-order replies and retains partial and coalesced frames", async () => {
  const f = fixture();
  const first = f.client.request("status", null), second = f.client.request("status", null);
  f.stream.emit("data", f.reply(1).slice(0, 10));
  f.stream.emit("data", f.reply(1).slice(10) + f.reply(0));
  expect(await Promise.all([first, second])).toEqual([denied, denied]);
  f.client.close();
});
it("ignores valid replies for unknown ids without consuming another request", async () => {
  vi.useFakeTimers(); const f = fixture(); const pending = f.client.request("status", null);
  f.stream.emit("data", JSON.stringify({ id: "unknown", result: denied }) + "\n");
  await vi.advanceTimersByTimeAsync(4999); expect(f.stream.destroy).not.toHaveBeenCalled();
  f.stream.emit("data", f.reply()); expect(await pending).toEqual(denied); f.client.close();
});
it("admits at most four pending requests and releases capacity after a reply", async () => {
  const f = fixture(); const pending = Array.from({ length: 4 }, () => f.client.request("status", null));
  expect(await f.client.request("status", null)).toEqual(unavailable);
  expect(f.stream.write).toHaveBeenCalledTimes(4);
  f.stream.emit("data", f.reply()); expect(await pending[0]).toEqual(denied);
  const next = f.client.request("status", null); expect(f.stream.write).toHaveBeenCalledTimes(5);
  f.client.close(); expect(await next).toEqual(unavailable); await Promise.all(pending);
});
it.each(["end", "close", "error"])("resolves every pending request on %s and cannot reopen", async event => {
  const f = fixture(); const pending = [f.client.request("status", null), f.client.request("status", null)];
  f.stream.emit(event, new Error("synthetic"));
  expect(await Promise.all(pending)).toEqual([unavailable, unavailable]);
  f.stream.emit("data", f.reply()); f.stream.emit("drain");
  expect(await f.client.request("status", null)).toEqual(unavailable);
  f.client.close(); expect(f.stream.destroy).toHaveBeenCalledTimes(1);
});
it("fails closed at the five-second deadline and resolves all pending calls", async () => {
  vi.useFakeTimers(); const f = fixture();
  const pending = [f.client.request("status", null), f.client.request("status", null)];
  await vi.advanceTimersByTimeAsync(5000);
  expect(await Promise.all(pending)).toEqual([unavailable, unavailable]);
  expect(f.client.isClosed).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
it.each([
  "not-json\n", JSON.stringify({ connected: true }) + "\n",
  JSON.stringify({ id: "synthetic", result: denied, extra: true }) + "\n",
  JSON.stringify({ id: 1, result: denied }) + "\n",
  JSON.stringify({ id: "synthetic", result: { ok: true } }) + "\n",
  "x".repeat(65_537), "é".repeat(32_769),
])("fails closed on a malformed or oversized response", async malformed => {
  const f = fixture(); const pending = f.client.request("status", null);
  f.stream.emit("data", malformed);
  expect(await pending).toEqual(unavailable); expect(f.client.isClosed).toBe(true);
});
it("stops processing a batch at its first invalid frame", async () => {
  const f = fixture(); const pending = f.client.request("status", null);
  f.stream.emit("data", "{}\n" + f.reply());
  expect(await pending).toEqual(unavailable);
});
it("bounds encoded request bytes and the writable queue before writing", async () => {
  const f = fixture();
  expect(await f.client.request("probe", { prompt: "é".repeat(8192), backend: "cpu" })).toEqual(unavailable);
  f.stream.writableLength = 65_536;
  expect(await f.client.request("status", null)).toEqual(unavailable);
  expect(f.stream.write).not.toHaveBeenCalled(); f.client.close();
});
it("does not write again until drain even if the blocked request already replied", async () => {
  vi.useFakeTimers(); const f = fixture(); f.stream.write.mockReturnValue(false);
  const pending = f.client.request("status", null); f.stream.emit("data", f.reply());
  expect(await pending).toEqual(denied);
  for (let n = 0; n < 20; n++) expect(await f.client.request("status", null)).toEqual(unavailable);
  expect(f.stream.write).toHaveBeenCalledTimes(1);
  f.stream.emit("drain"); f.stream.write.mockReturnValue(true);
  const next = f.client.request("status", null); expect(f.stream.write).toHaveBeenCalledTimes(2);
  f.client.close(); expect(await next).toEqual(unavailable); expect(vi.getTimerCount()).toBe(0);
});
it("closes a stalled writer after its reply settled without drain", async () => {
  vi.useFakeTimers(); const f = fixture(); f.stream.write.mockReturnValue(false);
  const pending = f.client.request("status", null); f.stream.emit("data", f.reply()); await pending;
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.client.isClosed).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
it("resolves requests when writing throws and consumes late stream errors", async () => {
  const f = fixture(); f.stream.write.mockImplementation(() => { throw new Error("synthetic"); });
  expect(await f.client.request("status", null)).toEqual(unavailable);
  expect(() => f.stream.emit("error", new Error("late synthetic"))).not.toThrow();
});
