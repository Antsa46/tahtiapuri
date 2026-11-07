import { expect, it } from "vitest";
import { nativeLaunchWorkerConfig, launchRecord } from "./native-launch-worker-config.js";
const input = () => ({ schema: 1, pid: process.pid,
  identity: "C:\\synthetic\\runtime\\helpers\\main-identity.exe",
  bootstrap: "C:\\synthetic\\runtime\\helpers\\main-bootstrap.exe",
  broker: "C:\\synthetic\\runtime\\bin\\mcp-broker.exe",
  controlFile: "C:\\synthetic\\control\\main-bootstrap.bin", env: { SystemRoot: "C:\\Windows" } });
it("snapshots fixed package/control/environment values", () => {
  const value = input(), snapshot = nativeLaunchWorkerConfig(value);
  value.env.SystemRoot = "changed"; expect(snapshot.env.SystemRoot).toBe("C:\\Windows");
  expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.env)).toBe(true);
});
it("rejects another Main PID", () => {
  expect(() => nativeLaunchWorkerConfig({ ...input(), pid: process.pid + 1 })).toThrow();
});
it("rejects mixed helper packages and wrong fixed executable names", () => {
  for (const field of ["identity", "bootstrap", "broker"] as const) {
    expect(() => nativeLaunchWorkerConfig({ ...input(), [field]: input()[field].replace("runtime", "other") })).toThrow();
    expect(() => nativeLaunchWorkerConfig({ ...input(), [field]: "C:\\synthetic\\other.exe" })).toThrow();
  }
});
it("rejects package overlap and noncanonical control paths", () => {
  for (const controlFile of ["C:\\synthetic\\runtime\\main-bootstrap.bin",
    "C:\\synthetic\\control\\..\\main-bootstrap.bin", "C:\\synthetic\\control\\other.bin",
    "\\\\remote\\share\\main-bootstrap.bin"])
    expect(() => nativeLaunchWorkerConfig({ ...input(), controlFile })).toThrow();
});
it("rejects command, URL and ambient executable options", () => {
  for (const extra of [{ argv: [] }, { workerUrl: "https://invalid.example/worker" }, { exe: "other" }])
    expect(() => nativeLaunchWorkerConfig({ ...input(), ...extra })).toThrow();
});
it("rejects environment hooks and NUL values", () => {
  for (const env of [{ NODE_OPTIONS: "--inspect" }, { HTTP_PROXY: "invalid" }, { SystemRoot: "bad\0value" }])
    expect(() => nativeLaunchWorkerConfig({ ...input(), env })).toThrow();
});
it("rejects accessor, symbol, array and custom-prototype records without reading getters", () => {
  let called = false;
  const accessor = Object.defineProperty({}, "kind", { enumerable: true, get() { called = true; return "identity"; } });
  expect(launchRecord(accessor)).toBe(false); expect(called).toBe(false);
  expect(launchRecord({ [Symbol("extra")]: 1 })).toBe(false);
  expect(launchRecord([])).toBe(false); expect(launchRecord(new Date())).toBe(false);
});

it.each([{}, { SystemRoot: "relative" }, { SystemRoot: "c:\\Windows" }, { SystemRoot: "\\\\remote\\Windows" }, { SystemRoot: "C:\\Windows\\..\\Windows" }])("requires a canonical bound Windows root rather than an ambient command lookup %j", env => {
  expect(() => nativeLaunchWorkerConfig({ ...input(), env })).toThrow();
});
