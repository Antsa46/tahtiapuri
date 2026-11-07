// Fixed clock-only fixture. No filesystem, child-process or network imports.
import { isMainThread, parentPort } from "node:worker_threads";
if (isMainThread || !parentPort) throw new Error("Clock fixture requires a worker");
parentPort.postMessage({ kind: "native-launch-clock-v1", pid: process.pid, tick: process.hrtime.bigint() });
parentPort.close();
