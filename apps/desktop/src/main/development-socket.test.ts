import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { writeDevelopmentFrame } from "./development-socket.js";
afterEach(() => vi.useRealTimers());
it("waits for drain and bounds a client that does not read replies", async () => {
  vi.useFakeTimers();
  const socket = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0, write: vi.fn(() => false) }) as unknown as Socket;
  const pending = writeDevelopmentFrame(socket, { ok: true });
  let complete = false; void pending.then(() => { complete = true; });
  await Promise.resolve(); expect(complete).toBe(false); socket.emit("drain"); await pending;
  const blocked = writeDevelopmentFrame(socket, { text: "x" });
  const check = expect(blocked).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(2000); await check;
  expect(socket.listenerCount("drain")).toBe(0);
});
it("rejects an exhausted output budget before another write", async () => {
  const write = vi.fn();
  const socket = { destroyed: false, writableLength: 131072, write } as unknown as Socket;
  await expect(writeDevelopmentFrame(socket, { ok: true })).rejects.toThrow("limit");
  expect(write).not.toHaveBeenCalled();
});
