import { createRequire, syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChildProcess } from "node:child_process";
const require = createRequire(import.meta.url);
const cp = require("node:child_process") as typeof import("node:child_process");
const fork = cp.fork;
cp.fork = ((...args: unknown[]) => {
  const child = Reflect.apply(fork, cp, args) as ChildProcess;
  if (String(args[0]).endsWith("testBindingBinary.js")) {
    const send = child.send;
    child.send = ((...messages: unknown[]) => {
      const message = messages[0] as { type?: string } | undefined;
      if (message?.type === "start") {
        writeFileSync("sdk-helper.json", JSON.stringify({ pid: child.pid, parent: process.pid, held: true }));
        return true;
      }
      return Reflect.apply(send!, child, messages);
    }) as ChildProcess["send"];
  }
  return child;
}) as typeof cp.fork;
syncBuiltinESMExports();
const root = join(import.meta.dirname, "../../..");
await import(pathToFileURL(join(root, "apps/backend/dist/runtime/model-worker.js")).href);
