import { expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runRoot = process.env.TAHTIAPURI_NATIVE_LAUNCH_CLOCK_RUN_ROOT;
const test = process.platform === "win32" && !!runRoot ? it : it.skip;
test("shares the process monotonic clock with a real Node worker thread", async () => {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  expect(resolve(runRoot!)).toBe(runRoot);
  expect(dirname(runRoot!)).toBe(join(project, ".artifacts/tests/native-launch-clock"));
  expect(basename(runRoot!)).toMatch(/^run-[a-f0-9]{32}$/);
  const before = process.hrtime.bigint(), end = performance.now() + 3000;
  const worker = new Worker(new URL("../../support/mcp/native-launch-clock.mjs", import.meta.url), {
    execArgv: [], argv: [], env: {}, stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4, stackSizeMb: 2 },
  });
  let exitKnown = false, messageSeen = false, stdioBytes = 0, forced = false;
  let resolveMessage!: (value: unknown) => void, rejectMessage!: (error: Error) => void;
  const message = new Promise<unknown>((resolveValue, reject) => { resolveMessage = resolveValue; rejectMessage = reject; });
  const closed = new Promise<number>(resolveExit => worker.once("exit", code => {
    exitKnown = true; resolveExit(code);
    if (!messageSeen) rejectMessage(new Error("Clock worker exited without a receipt"));
  }));
  worker.once("message", value => { messageSeen = true; resolveMessage(value); });
  worker.on("error", error => rejectMessage(error));
  for (const stream of [worker.stdout, worker.stderr]) {
    stream.on("error", error => rejectMessage(error));
    stream.on("data", (bytes: Buffer) => {
      stdioBytes += bytes.length;
      if (stdioBytes > 1024) rejectMessage(new Error("Clock fixture output cap"));
    });
  }
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const remaining = end - performance.now();
      if (remaining <= 0) throw new Error("Clock fixture original deadline expired");
      const value = await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Clock fixture deadline")), remaining);
      })]);
      if (performance.now() >= end) throw new Error("Clock fixture late completion");
      return value;
    } finally { clearTimeout(timer); }
  };
  let tick: bigint | undefined, after: bigint | undefined, exit: number | undefined;
  try {
    const row = await bounded(message); after = process.hrtime.bigint();
    expect(row && typeof row === "object").toBe(true);
    const value = row as Record<string, unknown>;
    expect(Object.keys(value).sort()).toEqual(["kind", "pid", "tick"]);
    expect(value.kind).toBe("native-launch-clock-v1"); expect(value.pid).toBe(process.pid);
    expect(typeof value.tick).toBe("bigint"); tick = value.tick as bigint;
    expect(tick).toBeGreaterThanOrEqual(before); expect(tick).toBeLessThanOrEqual(after);
    exit = await bounded(closed); expect(exit).toBe(0); expect(stdioBytes).toBe(0);
  } finally {
    if (!exitKnown) {
      // Only this pinned clock-only fixture has no possible native child.
      // Never use this termination pattern for the production launch worker.
      forced = true; let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([worker.terminate(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Clock-only worker cleanup deadline")), 1000);
        })]);
      } finally { clearTimeout(timer); }
    }
  }
  expect(forced).toBe(false); expect(exitKnown).toBe(true);
  await writeFile(join(runRoot!, "clock-result.json"), JSON.stringify({ passed: true,
    parentBefore: before.toString(), workerTick: tick!.toString(), parentAfter: after!.toString(),
    sameProcess: true, exit, exitKnown, forced, stdioBytes, nativeHelperStarted: false,
    scope: "One real Windows Node worker clock/exit observation; not Electron packaging or native helper startup acceptance",
  }, null, 2) + "\n", { flag: "wx" });
}, 10000);
