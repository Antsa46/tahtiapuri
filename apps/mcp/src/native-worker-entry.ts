import { startMcpMuxWorker } from "./mcp-mux-worker.js";

// Fixed worker entry. Bootstrap paths, credentials and launch policy belong to
// the trusted native broker; none can be supplied as worker arguments.
if (process.argv.length !== 2) {
  process.exitCode = 64;
} else {
  const worker = startMcpMuxWorker(process.stdin, process.stdout);
  void worker.finished.then(outcome => { process.exitCode = outcome === "closed" ? 0 : 1; });
}
