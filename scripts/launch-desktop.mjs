import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const tools = JSON.parse(readFileSync(join(root, "scripts/dev/toolchain.json"), "utf8"));
if (process.platform !== "win32") throw new Error("Tämä kehityskoe ajetaan Windowsissa.");
const executable = join(root, ".local/toolchain", `electron-${tools.electron.version}`, "electron.exe");
if (!existsSync(executable)) throw new Error("Suorita ensin scripts/dev.ps1 install.");
if (!existsSync(join(root, "apps/desktop/dist/main/index.js"))) throw new Error("Suorita ensin scripts/dev.ps1 build.");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const child = spawn(executable, [root], { cwd: root, env, stdio: "inherit" });
child.on("error", () => { console.error("Tähtiapurin käynnistys epäonnistui."); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
