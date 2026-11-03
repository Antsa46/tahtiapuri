import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";
import type { DevelopmentResult } from "@tahtiapuri/validation/development";
import { DevelopmentHost } from "./development-host.js";
vi.mock("./private-development-directory.js", () => ({ secureDevelopmentDirectory: vi.fn(async () => {}) }));
vi.mock("node:fs/promises", async original => {
  const real = await original<typeof import("node:fs/promises")>();
  return { ...real, writeFile: vi.fn(real.writeFile) };
});
afterEach(() => vi.restoreAllMocks());
for (const action of ["disable", "stop"] as const) {
  it("revokes an in-flight descriptor write and bounds a control flood: " + action, async () => {
    await mkdir(".artifacts/tests", { recursive: true });
    const directory = await mkdtemp(join(".artifacts/tests", "development-race-"));
    let openWrite!: () => void, continueWrite!: () => void, continueControl!: () => void;
    const observed = new Promise<void>(resolve => { openWrite = resolve; });
    const writeGate = new Promise<void>(resolve => { continueWrite = resolve; });
    const controlGate = new Promise<void>(resolve => { continueControl = resolve; });
    let descriptor: { pipe: string; token: string } | undefined;
    const original = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).writeFile;
    vi.mocked(writeFile).mockImplementation(async (path, data, options) => {
      descriptor = JSON.parse(String(data)); openWrite();
      await writeGate; return original(path, data, options);
    });
    let epoch: unknown = null, cancelled = false, configures = 0;
    const development = vi.fn(async (operation: string, input?: unknown): Promise<DevelopmentResult> => {
      if (operation === "development.configure") {
        epoch = input; configures++;
        if (cancelled && input === null) await controlGate;
      } else if (cancelled && operation === "development.status" && epoch !== null) await controlGate;
      return { ok: true, status: { enabled: epoch !== null, connected: false, protocolVersion: 1, engineVersion: "3.22.2", modelId: "qwen3-4b-q4-k-m" } };
    });
    const host = new DevelopmentHost({ development }, directory);
    const opening = host.setEnabled(true);
    await observed;
    try {
      const denied = await Promise.all(Array.from({ length: 128 }, () => host.setEnabled(true)));
      expect(denied.every(x => !x.ok && x.code === "BUSY")).toBe(true);
      cancelled = true;
      const closing = action === "stop" ? host.stop() : host.setEnabled(false);
      const redundant = Array.from({ length: 128 }, () => host.setEnabled(false));
      expect(new Set(redundant).size).toBe(1);
      continueWrite();
      await new Promise(resolve => setTimeout(resolve, 20));
      if (!descriptor) throw new Error();
      let received = 0;
      const socket = createConnection(descriptor.pipe);
      socket.on("error", () => {}); socket.on("data", chunk => { received += chunk.length; socket.destroy(); });
      const gone = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error("Revoked socket remained open.")); }, 1500);
        socket.once("close", () => { clearTimeout(timer); resolve(); });
      });
      socket.once("connect", () => socket.write(JSON.stringify({ token: descriptor!.token }) + "\n"));
      await gone;
      expect(received).toBe(0);
      continueControl();
      await opening; await closing; await Promise.all(redundant);
      expect(await host.getStatus()).toMatchObject({ status: { enabled: false } });
      expect(configures).toBeLessThan(8);
      expect(await access(join(directory, "connection.json")).then(() => true, () => false)).toBe(false);
    } finally {
      continueWrite(); continueControl();
      await host.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
