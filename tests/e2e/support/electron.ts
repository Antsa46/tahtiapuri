import { _electron, expect, type ElectronApplication } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
const root = process.cwd();
export const executable = join(root, ".local/toolchain/electron-45.2.1/electron.exe");
const entry = join(root, ".artifacts/tests/e2e-build/main.js");
function environment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"].includes(entry[0])));
}
export async function launch(data: string, scenario = "normal") {
  await mkdir(data, { recursive: true });
  return _electron.launch({ executablePath: executable, args: [entry, scenario, data], cwd: root, env: environment() });
}
export async function backendPid(application: ElectronApplication): Promise<number> {
  await application.firstWindow();
  const pid = await application.evaluate(({ app }) =>
    app.getAppMetrics().find(metric => metric.name === "Tahtiapuri Backend")?.pid);
  if (!pid) throw new Error("Owned backend process missing.");
  return pid;
}
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export async function expectGone(pid: number) {
  await expect.poll(() => isAlive(pid), { timeout: 15_000 }).toBe(false);
}
export async function failingStartup(data: string, scenario: "early-exit" | "unresponsive" | "unready-ui") {
  await mkdir(data, { recursive: true });
  const process = spawn(executable, [entry, scenario, data], { cwd: root, env: environment(), stdio: "pipe" });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { process.kill(); reject(new Error("Failed-start cleanup timed out.")); }, 12_000);
    process.once("exit", code => { clearTimeout(timer); resolve(code); });
    process.once("error", error => { clearTimeout(timer); reject(error); });
  });
  const pid = Number(await readFile(join(data, "fixture-backend.pid"), "utf8"));
  expect(code).toBe(1);
  await expectGone(pid);
}
