import { exactKeys, isRecord } from "@tahtiapuri/validation/public";

// This module handles bytes only. Process launch, policy selection, state/order
// validation and accepting a terminal result belong to the owning model host.
export const NATIVE_MODEL_LIMITS = Object.freeze({
  headerBytes: 48, inputBytes: 8000, outputBytes: 8192,
  ownerFrames: 32, ownerBytes: 32768,
  brokerRecords: 32, brokerLineBytes: 16896, brokerBytes: 65536,
  context: 4096, batch: 32, threads: 1, maxInputTokens: 3072, maxOutputTokens: 512,
});
export const NATIVE_FAILURE_STAGES = Object.freeze([
  "runtime-load", "model-load", "template-identity", "model-context", "input-invalid",
  "input-tokens", "generation-failed", "cancelled", "internal",
]);
export const NATIVE_MODEL_OP = Object.freeze({ hello: 1, begin: 3, cancel: 4, shutdown: 6, load: 11,
  ready: 129, pending: 131, cancelled: 132, bye: 134, done: 135, loaded: 136, computing: 137, failed: 138 });
export class NativeProtocolError extends Error {
  constructor() { super("Native model protocol rejected."); }
}
const reject = (): never => { throw new NativeProtocolError(); };
const uint = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const positive = (value: unknown): value is number => uint(value) && value > 0;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export function nativeText(bytes: Uint8Array): string {
  try {
    const result = utf8.decode(bytes);
    if (result.includes("\0")) reject();
    return result;
  } catch { return reject(); }
}
export function nativePromptBody(prompt: string): Buffer {
  // Buffer.from would silently replace an unpaired UTF-16 surrogate.
  if (prompt.length === 0 || prompt.length > 2000 || prompt.includes("\0") || !prompt.trim()) return reject();
  const body = Buffer.from(prompt, "utf8");
  if (body.toString("utf8") !== prompt || body.length > NATIVE_MODEL_LIMITS.inputBytes) return reject();
  return body;
}
export class NativeOwnerFrames {
  private readonly session: Buffer;
  private count = 0;
  private bytes = 0;
  constructor(session: string) {
    if (!/^[a-f0-9]{64}$/.test(session)) reject();
    this.session = Buffer.from(session, "hex");
  }
  create(op: number, prompt?: string): { id: number; bytes: Buffer } {
    let body: Buffer = Buffer.alloc(0);
    if (op === NATIVE_MODEL_OP.begin) {
      if (typeof prompt !== "string") return reject();
      body = nativePromptBody(prompt);
    } else if (!(op === NATIVE_MODEL_OP.hello || op === NATIVE_MODEL_OP.load || op === NATIVE_MODEL_OP.shutdown) || prompt !== undefined) return reject();
    const size = NATIVE_MODEL_LIMITS.headerBytes + body.length;
    if (this.count + 1 > NATIVE_MODEL_LIMITS.ownerFrames || this.bytes + size > NATIVE_MODEL_LIMITS.ownerBytes) return reject();
    const id = ++this.count; this.bytes += size;
    const bytes = Buffer.alloc(size);
    bytes.write("TAIP", 0, "ascii"); bytes[4] = 1;
    bytes.writeUInt16LE(op, 6); bytes.writeUInt32LE(id, 8); bytes.writeUInt32LE(body.length, 12);
    this.session.copy(bytes, 16); body.copy(bytes, NATIVE_MODEL_LIMITS.headerBytes);
    return { id, bytes };
  }
}
export type NativeFrame = { type: "frame"; op: number; id: number; body: Buffer };
export type NativeLaunch = {
  type: "launched"; requestedPolicy: "lpac"; pid: number; appContainer: true;
  lpac: true | null; lpacQueryError: number; lpacQueryBytes: number;
  capabilities: 0; integrity: 4096; sid: string; job: true; activeProcessLimit: 1;
  affinity: 1; priority: "BelowNormal"; jobCommitBytes: number;
  sentinelInherited: false; aclsVerified: true; networkVerified: false;
};
export type NativeResult = { type: "result"; case: "desktop"; passed: boolean; jobEmpty: boolean;
  profileDeleted: boolean; watchdogReason: number; failure: string; error: number };
export type NativeRecord = NativeFrame | NativeLaunch | NativeResult;
const launchKeys = ["type", "requestedPolicy", "pid", "appContainer", "lpac", "lpacQueryError", "lpacQueryBytes", "capabilities", "integrity", "sid",
  "job", "activeProcessLimit", "affinity", "priority", "jobCommitBytes", "sentinelInherited", "aclsVerified", "networkVerified"];
function record(value: unknown): NativeRecord {
  if (!isRecord(value)) return reject();
  if (value.type === "frame") {
    if (!exactKeys(value, ["type", "op", "id", "bodyHex"]) || !positive(value.id) || value.id > NATIVE_MODEL_LIMITS.ownerFrames
      || !uint(value.op) || typeof value.bodyHex !== "string" || value.bodyHex.length > (NATIVE_MODEL_LIMITS.outputBytes + 16) * 2
      || !/^(?:[0-9a-f]{2})*$/.test(value.bodyHex)) return reject();
    const body = Buffer.from(value.bodyHex, "hex");
    const op = value.op, size = body.length;
    if ([129, 131, 137].includes(op) ? size !== 0
      : op === 132 ? size !== 4 || !positive(body.readUInt32LE()) || body.readUInt32LE() > NATIVE_MODEL_LIMITS.ownerFrames
      : op === 134 ? size !== 12 || body.readUInt32LE() !== 1 || body.readUInt32LE(4) > 1 || body.readUInt32LE(8) > 2
      : op === 136 ? size !== 88 || [4096, 32, 32, 1, 1, 0].some((n, i) => body.readUInt32LE(i * 4) !== n)
        || !body.subarray(24).equals(Buffer.from("57f1fd00f0013a2be96aa79b857391f27e23df5b5f847072b524c897e24d0361", "ascii"))
      : op === 135 ? size < 16 || body.readUInt32LE() === 0 || body.readUInt32LE() > NATIVE_MODEL_LIMITS.maxInputTokens
        || body.readUInt32LE(4) > NATIVE_MODEL_LIMITS.maxOutputTokens || body.readUInt32LE(8) > 2 || body.readUInt32LE(12) > 1
      : op === 138 ? size < 5 || size > 132 || !NATIVE_FAILURE_STAGES.includes(nativeText(body.subarray(4)))
      : true) return reject();
    if (op === NATIVE_MODEL_OP.done) nativeText(body.subarray(16));
    return { type: "frame", op, id: value.id, body };
  }
  if (value.type === "launched") {
    if (!exactKeys(value, launchKeys) || value.requestedPolicy !== "lpac" || !positive(value.pid) || value.appContainer !== true
      || !(value.lpac === null ? value.lpacQueryError === 87 && value.lpacQueryBytes === 0
        : value.lpac === true && value.lpacQueryError === 0 && value.lpacQueryBytes === 4)
      || value.capabilities !== 0 || value.integrity !== 4096 || typeof value.sid !== "string" || value.sid.length > 128 || !/^S-1-15-2-(?:[0-9]+-){6}[0-9]+$/.test(value.sid)
      || value.job !== true || value.activeProcessLimit !== 1 || value.affinity !== 1 || value.priority !== "BelowNormal"
      || value.jobCommitBytes !== 6 * 1024 ** 3 || value.sentinelInherited !== false || value.aclsVerified !== true || value.networkVerified !== false) return reject();
    return value as NativeLaunch;
  }
  if (value.type === "result") {
    if (!exactKeys(value, ["type", "case", "passed", "jobEmpty", "profileDeleted", "watchdogReason", "failure", "error"])
      || value.case !== "desktop" || typeof value.passed !== "boolean" || typeof value.jobEmpty !== "boolean" || typeof value.profileDeleted !== "boolean"
      || !uint(value.watchdogReason) || value.watchdogReason > 2 || !uint(value.error) || typeof value.failure !== "string"
      || value.failure.length > 128 || !/^[a-z0-9-]*$/.test(value.failure)) return reject();
    return value as NativeResult;
  }
  return reject();
}
export class NativeBrokerRecords {
  private pending = Buffer.alloc(0);
  private bytes = 0;
  private count = 0;
  private ended = false;
  private rejected = false;
  push(chunk: Uint8Array, accept: (value: NativeRecord) => void): void {
    try {
      if (this.ended || this.rejected || this.bytes + chunk.length > NATIVE_MODEL_LIMITS.brokerBytes) return reject();
      this.bytes += chunk.length;
      // Never concatenate an unbounded incoming chunk before finding line ends.
      let offset = 0;
      while (offset < chunk.length) {
        const rest = chunk.subarray(offset), newline = rest.indexOf(10);
        const part = newline < 0 ? rest : rest.subarray(0, newline);
        if (this.pending.length + part.length > NATIVE_MODEL_LIMITS.brokerLineBytes) return reject();
        this.pending = Buffer.concat([this.pending, part]);
        offset += part.length + (newline < 0 ? 0 : 1);
        if (newline < 0) break;
        if (++this.count > NATIVE_MODEL_LIMITS.brokerRecords || this.pending.length === 0) return reject();
        const line = nativeText(this.pending); this.pending = Buffer.alloc(0);
        accept(record(JSON.parse(line)));
      }
    } catch { this.rejected = true; return reject(); }
  }
  finish(): void {
    if (this.rejected || this.ended || this.pending.length) { this.rejected = true; return reject(); }
    this.ended = true;
  }
}
