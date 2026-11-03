import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const root = process.cwd(), tool = JSON.parse(readFileSync(join(root, "scripts/dev/toolchain.json"), "utf8"));
if (process.platform !== "win32") throw new Error("Windows x64 comparison only");
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
const child = spawn(join(root, ".local/toolchain/electron-" + tool.electron.version, "electron.exe"),
  [join(root, ".artifacts/tests/evaluation-build/local-model/comparison-main.js"), process.argv.at(-1) === "smoke" ? "smoke" : "full"],
  { cwd: root, env, stdio: "inherit" });
const launchedAt = Date.now();
const bootGuard = setInterval(() => {
  try {
    const file = join(root, ".artifacts/tests/evaluations/local-model/latest-" + (process.argv.at(-1) === "smoke" ? "smoke" : "full") + ".json");
    if (statSync(file).mtimeMs >= launchedAt - 1000) { clearInterval(bootGuard); return; }
  } catch {}
  if (Date.now() - launchedAt > 30_000) { console.error("Evaluation startup timed out"); child.kill(); clearInterval(bootGuard); }
}, 1000);
child.once("exit", () => clearInterval(bootGuard));
child.on("error", () => { process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
