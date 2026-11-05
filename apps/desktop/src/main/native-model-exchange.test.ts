import { expect, it, vi } from "vitest";
import { NativeModelExchange } from "./native-model-exchange.js";
import { NativeBrokerRecords, NATIVE_MODEL_OP as op } from "./native-model-protocol.js";
const session = "00".repeat(32);
const launch = { type: "launched", requestedPolicy: "lpac", pid: 1234, appContainer: true,
  lpac: null, lpacQueryError: 87, lpacQueryBytes: 0, capabilities: 0, integrity: 4096,
  sid: "S-1-15-2-1-2-3-4-5-6-7", job: true, activeProcessLimit: 1, affinity: 1,
  priority: "BelowNormal", jobCommitBytes: 6 * 1024 ** 3, sentinelInherited: false,
  aclsVerified: true, networkVerified: false };
const terminal = { type: "result", case: "desktop", passed: true, jobEmpty: true, profileDeleted: true,
  watchdogReason: 0, failure: "", error: 0 };
function words(...values: number[]) { const bytes = Buffer.alloc(values.length * 4); values.forEach((v, i) => bytes.writeUInt32LE(v, i * 4)); return bytes; }
const frame = (code: number, id: number, body = Buffer.alloc(0)) => ({ type: "frame", op: code, id, bodyHex: body.toString("hex") });
const loaded = () => Buffer.concat([words(4096, 32, 32, 1, 1, 0), Buffer.from("57f1fd00f0013a2be96aa79b857391f27e23df5b5f847072b524c897e24d0361")]);
function setup() {
  const sent: Buffer[] = [], progress = vi.fn(), parser = new NativeBrokerRecords();
  let time = 0;
  const exchange = new NativeModelExchange(session, "Jupiter", x => sent.push(x), progress, () => ++time);
  const receive = (value: unknown) => parser.push(Buffer.from(JSON.stringify(value) + "\n"), x => exchange.receive(x));
  const shutdown = () => sent.findLast(x => x.readUInt16LE(6) === op.shutdown)!.readUInt32LE(8);
  const boot = () => { exchange.start(); receive(launch); receive(frame(op.ready, 1)); };
  const load = () => { boot(); receive(frame(op.pending, 2)); receive(frame(op.loaded, 2, loaded())); };
  const generating = () => { load(); receive(frame(op.pending, 3)); receive(frame(op.computing, 3)); };
  const close = () => { receive(frame(op.bye, shutdown(), words(1, 0, 0))); receive(terminal); parser.finish(); };
  return { exchange, sent, progress, receive, shutdown, boot, load, generating, close };
}
it("runs the closed handshake and keeps a candidate behind final cleanup receipts", () => {
  const s = setup(); s.generating();
  s.receive(frame(op.done, 3, Buffer.concat([words(100, 2, 0, 0), Buffer.from("Jupiter")])));
  expect(() => s.exchange.candidateAfterBrokerExit(0)).toThrow();
  expect(s.sent.map(x => [x.readUInt16LE(6), x.readUInt32LE(8)])).toEqual([[1, 1], [11, 2], [3, 3], [6, 4]]);
  expect(s.progress).toHaveBeenCalledTimes(1);
  s.close();
  expect(s.exchange.candidateAfterBrokerExit(0)).toMatchObject({ text: "Jupiter", error: null,
    info: { engineVersion: "llama.cpp-v0.9.0-cpu", backend: "cpu", contextSize: 4096, gpuLayers: 0 } });
  expect(() => s.exchange.candidateAfterBrokerExit(1)).toThrow();
});
for (const phase of ["before-start", "hello", "load-pending", "loaded", "generating", "done"] as const) {
  it("closes idempotently and discards late model text on cancellation during " + phase, () => {
    const s = setup();
    if (phase === "before-start") { s.exchange.cancel(); s.exchange.start(); s.receive(launch); }
    else if (phase === "hello") { s.exchange.start(); s.receive(launch); s.exchange.cancel(); s.receive(frame(op.ready, 1)); }
    else if (phase === "load-pending") { s.boot(); s.receive(frame(op.pending, 2)); s.exchange.cancel(); s.receive(frame(op.loaded, 2, loaded())); }
    else if (phase === "loaded") { s.load(); s.exchange.cancel(); s.receive(frame(op.pending, 3)); s.receive(frame(op.computing, 3));
      s.receive(frame(op.done, 3, Buffer.concat([words(100, 2, 0, 0), Buffer.from("Late")]))); }
    else { s.generating(); if (phase === "done") s.receive(frame(op.done, 3, Buffer.concat([words(100, 2, 0, 0), Buffer.from("Late")]))); }
    s.exchange.cancel(); s.exchange.cancel();
    expect(s.sent.filter(x => x.readUInt16LE(6) === op.shutdown)).toHaveLength(1);
    s.close(); expect(s.exchange.candidateAfterBrokerExit(0)).toEqual({ text: "", error: "CANCELLED", info: null });
    if (phase === "hello" || phase === "load-pending" || phase === "before-start") expect(s.progress).not.toHaveBeenCalled();
  });
}
it.each(["input-invalid", "input-tokens", "model-load", "template-identity", "generation-failed", "runtime-load"])("maps the fixed native failure stage %s", stage => {
  const s = setup(); s.load(); s.receive(frame(op.pending, 3));
  s.receive(frame(op.failed, 3, Buffer.concat([words(13), Buffer.from(stage)])));
  s.close();
  const expected = stage.startsWith("input-") ? "INVALID_INPUT" : ["model-load", "template-identity"].includes(stage) ? "MODEL_INVALID"
    : stage === "generation-failed" ? "ENGINE_CRASHED" : "ENGINE_UNAVAILABLE";
  expect(s.exchange.candidateAfterBrokerExit(0)).toMatchObject({ text: "", error: expected, info: null });
});
it("allows a verified preparatory cancellation before any worker exists", () => {
  const s = setup(); s.exchange.start(); s.exchange.cancel();
  s.receive({ ...terminal, passed: false, failure: "cancelled", error: 995 });
  expect(s.exchange.candidateAfterBrokerExit(1)).toEqual({ text: "", error: "CANCELLED", info: null });
});
it.each([
  frame(op.loaded, 2, loaded()), frame(op.done, 3, Buffer.concat([words(100, 1, 0, 0), Buffer.from("forged")])),
  frame(op.ready, 9), frame(op.ready, 1), frame(op.bye, 2, words(1, 0, 0)),
])("rejects unrequested, out-of-order or duplicate frames %#", value => {
  const s = setup(); s.boot(); expect(() => s.receive(value)).toThrow();
});
it("rejects a frame before launch and never accepts cleanup omission", () => {
  const s = setup(); s.exchange.start(); expect(() => s.receive(frame(op.ready, 1))).toThrow();
  for (const bad of [{ ...terminal, jobEmpty: false }, { ...terminal, profileDeleted: false }, terminal]) {
    const other = setup(); other.exchange.start(); expect(() => other.receive(bad)).toThrow();
  }
});
it("rejects duplicate terminal events and any model frame after bye or result", () => {
  const s = setup(); s.generating(); const done = frame(op.done, 3, words(100, 1, 0, 0)); s.receive(done);
  expect(() => s.receive(done)).toThrow();
  const other = setup(); other.exchange.cancel(); other.exchange.start(); other.receive(launch);
  other.receive(frame(op.bye, 1, words(1, 0, 0)));
  expect(() => other.receive(frame(op.ready, 1))).toThrow();
});
it("does not turn a failed broker result into a successful model answer", () => {
  const s = setup(); s.generating(); s.receive(frame(op.done, 3, words(100, 1, 0, 0)));
  s.receive({ ...terminal, passed: false, failure: "worker-close", error: 13 });
  expect(s.exchange.candidateAfterBrokerExit(1)).toMatchObject({ text: "", error: "ENGINE_CRASHED" });
});
it("requires a real broker exit matching the cleanup report", () => {
  const s = setup(); s.exchange.cancel(); s.exchange.start(); s.receive(launch); s.close();
  expect(() => s.exchange.candidateAfterBrokerExit(null)).toThrow();
});
