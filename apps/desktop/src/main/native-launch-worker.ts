import { parentPort, isMainThread, workerData } from "node:worker_threads";
import { spawn } from "node:child_process";
import { NativeLaunchWorkerCore } from "./native-launch-worker-core.js";

if (isMainThread || !parentPort || process.platform !== "win32") throw new Error("Native launch worker requires Windows worker_threads");
const port = parentPort;
const owner = new NativeLaunchWorkerCore(workerData, {
  spawn: (file, args, options) => spawn(file, args, options),
  post: value => port.postMessage(value),
  retire: uncertain => { if (uncertain) process.exitCode = 1; port.close(); },
});
port.on("message", value => owner.receive(value));
port.on("messageerror", () => owner.peerFailed());
port.on("close", () => owner.peerFailed());
