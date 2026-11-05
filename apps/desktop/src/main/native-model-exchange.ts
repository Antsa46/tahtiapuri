import { MODEL_ID, NATIVE_ENGINE_VERSION, type EngineReply, type EngineInfo, type ModelErrorCode } from "@tahtiapuri/validation/assistant";
import { NativeOwnerFrames, NativeProtocolError, nativeText, NATIVE_MODEL_OP as op, type NativeRecord, type NativeFrame, type NativeResult } from "./native-model-protocol.js";
type Request = { kind: "hello" | "load" | "begin" | "shutdown"; step: number };
const failure = (error: ModelErrorCode): EngineReply => ({ text: "", error, info: null });
const reject = (): never => { throw new NativeProtocolError(); };

// One exchange owns one worker and one inference. This state machine supplies
// no OS evidence: the host must confirm broker exit AND resource cleanup.
export class NativeModelExchange {
  private readonly owner: NativeOwnerFrames;
  private readonly requests = new Map<number, Request>();
  private launched = false;
  private started = false;
  private cancelled = false;
  private closing = false;
  private bye = false;
  private result: NativeResult | undefined;
  private reply: EngineReply | undefined;
  private loadAt = 0;
  private generateAt = 0;
  private info: EngineInfo | undefined;
  constructor(session: string, private readonly prompt: string,
    private readonly send: (bytes: Buffer) => void, private readonly progress: () => void,
    private readonly clock: () => number = () => performance.now()) { this.owner = new NativeOwnerFrames(session); }
  private request(kind: Request["kind"], code: number, prompt?: string) {
    const frame = this.owner.create(code, prompt);
    this.requests.set(frame.id, { kind, step: 0 });
    this.send(frame.bytes);
  }
  start() {
    if (this.started) return reject();
    this.started = true;
    if (this.cancelled) { this.close(); return; }
    this.request("hello", op.hello);
  }
  cancel() {
    this.cancelled = true;
    if (this.started && !this.result) this.close();
  }
  private close() {
    if (this.closing) return;
    this.closing = true; this.request("shutdown", op.shutdown);
  }
  receive(record: NativeRecord) {
    if (!this.started || this.result) return reject();
    if (record.type === "launched") {
      if (this.launched) return reject();
      this.launched = true; return;
    }
    if (record.type === "result") {
      if (!record.jobEmpty || !record.profileDeleted) return reject();
      if (record.passed && (!this.launched || !this.bye || record.watchdogReason !== 0 || record.failure !== "" || record.error !== 0)) return reject();
      // A preparatory cancellation can finish without creating a worker.
      if (!this.launched && record.passed) return reject();
      this.result = record; return;
    }
    if (!this.launched) return reject();
    this.frame(record);
  }
  private frame(frame: NativeFrame) {
    const request = this.requests.get(frame.id);
    if (!request) return reject();
    if (request.kind === "shutdown") {
      if (frame.op !== op.bye || request.step !== 0 || this.bye) return reject();
      request.step = 1; this.bye = true; return;
    }
    if (this.bye) return reject();
    if (request.kind === "hello") {
      if (frame.op !== op.ready || request.step !== 0) return reject();
      request.step = 1;
      if (!this.closing) { this.loadAt = this.clock(); this.request("load", op.load); }
      return;
    }
    if (frame.op === op.pending) {
      if (request.step !== 0) return reject();
      request.step = 1; return;
    }
    if (request.step === 0 || request.step === 3) return reject();
    if (frame.op === op.failed) {
      request.step = 3;
      if (!this.closing) {
        const stage = nativeText(frame.body.subarray(4));
        this.reply = failure(stage === "input-invalid" || stage === "input-tokens" ? "INVALID_INPUT"
          : stage === "model-load" || stage === "template-identity" ? "MODEL_INVALID"
          : stage === "generation-failed" ? "ENGINE_CRASHED" : "ENGINE_UNAVAILABLE");
        this.close();
      }
      return;
    }
    if (request.kind === "load") {
      if (frame.op !== op.loaded || request.step !== 1) return reject();
      request.step = 3;
      if (!this.closing) {
        this.info = { backend: "cpu", gpuLayers: 0, loadMs: Math.max(0, this.clock() - this.loadAt), generationMs: 0,
          contextSize: 4096, engineVersion: NATIVE_ENGINE_VERSION, modelId: MODEL_ID };
        this.generateAt = this.clock(); this.request("begin", op.begin, this.prompt);
      }
      return;
    }
    if (frame.op === op.computing) {
      if (request.step !== 1) return reject();
      request.step = 2; if (!this.closing) this.progress(); return;
    }
    if (frame.op !== op.done || request.step !== 2) return reject();
    request.step = 3;
    if (!this.closing) {
      if (!this.info || frame.body.readUInt32LE(8) === 2 || frame.body.readUInt32LE(12) !== 0) return reject();
      this.reply = { text: nativeText(frame.body.subarray(16)), error: null,
        info: { ...this.info, generationMs: Math.max(0, this.clock() - this.generateAt) } };
      this.close();
    }
  }
  // A candidate is useful only after the surrounding host has also deleted its
  // staging tree. This function itself cannot assert those filesystem effects.
  candidateAfterBrokerExit(exitCode: number | null): EngineReply {
    const result = this.result;
    if (!result || !result.jobEmpty || !result.profileDeleted || exitCode !== (result.passed ? 0 : 1)) return reject();
    if (this.cancelled) return failure("CANCELLED");
    if (!result.passed) return failure(result.watchdogReason === 2 ? "TIMEOUT" : "ENGINE_CRASHED");
    if (!this.reply) return reject();
    return this.reply;
  }
}
