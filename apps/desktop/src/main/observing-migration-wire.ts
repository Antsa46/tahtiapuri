import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { planObservingMigration } from "./observing-migration.js";

type Outcome = 1 | 2 | 3;
const MAX_SNAPSHOT = 32_768;
const rejected = () => new Error("Native backend migration protocol rejected.");

/** One native-owned snapshot pair. No filesystem access or worker APP messages. */
export class ObservingMigrationWire {
  private phase: "source" | "destination" | "migrated" | "complete" | "blocked" | "closed" = "source";
  private sourceBytes: Buffer | undefined;
  private mode: 0 | 1 | undefined;
  private outcome: Outcome | undefined;

  get complete(): boolean { return this.phase === "complete"; }

  acceptSource(body: Buffer): void {
    if (this.phase !== "source" || !Buffer.isBuffer(body) || body.length < 5 || body.length > MAX_SNAPSHOT + 4
      || body[0] !== 1 || (body[1] !== 0 && body[1] !== 1) || (body[2] !== 0 && body[2] !== 1) || body[3] !== 0) this.reject();
    // Origin describes this transaction only. Historical marker binding belongs
    // to native I/O and must not be inferred from origin on a later run.
    this.mode = body[1] as 0 | 1;
    this.sourceBytes = Buffer.from(body.subarray(4));
    this.phase = "destination";
  }

  decide(body: Buffer): Buffer {
    if (this.phase !== "destination" || !this.sourceBytes || !Buffer.isBuffer(body) || body.length < 4 || body.length > MAX_SNAPSHOT + 4
      || body[0] !== 1 || (body[1] !== 0 && body[1] !== 1) || body[2] !== 0 || body[3] !== 0
      || (body[1] === 0 ? body.length !== 4 : body.length === 4)) this.reject();
    const source = this.sourceBytes;
    const destination = body[1] === 1 ? body.subarray(4) : null;
    if (source.length + (destination?.length ?? 0) > 65_536) this.reject();
    let action: 0 | Outcome = 0;
    try {
      // Storage-v1 envelope/checksum/state validation remains with the existing
      // pure planner. Fatal UTF-8 prevents replacement-character admission.
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      decoder.decode(source); if (destination) decoder.decode(destination);
      if (this.mode === 1) {
        // Native has authenticated marker/source binding. Validate both current
        // documents independently, permitting legitimate native destination edits.
        if (destination && planObservingMigration(source, null).kind === "copy"
          && planObservingMigration(destination, null).kind === "copy") action = 3;
      } else {
        const plan = planObservingMigration(source, destination);
        if (plan.kind === "copy") action = 1;
        else if (plan.kind === "already-present") action = 2;
      }
    } catch { /* Invalid content produces a hash-bound blocked decision. */ }
    const decision = Buffer.alloc(68);
    decision[0] = 1; decision[1] = action; decision[2] = destination ? 1 : 0;
    createHash("sha256").update(source).digest().copy(decision, 4);
    if (destination) createHash("sha256").update(destination).digest().copy(decision, 36);
    this.sourceBytes = undefined; this.mode = undefined;
    this.outcome = action === 0 ? undefined : action;
    this.phase = action === 0 ? "blocked" : "migrated";
    return decision;
  }

  acceptMigrated(body: Buffer): void {
    if (this.phase !== "migrated" || !Buffer.isBuffer(body) || body.length !== 2 || body[0] !== 1 || body[1] !== this.outcome) this.reject();
    this.outcome = undefined; this.phase = "complete";
  }

  cancel(): void { this.sourceBytes = undefined; this.mode = undefined; this.outcome = undefined; this.phase = "closed"; }
  private reject(): never { this.cancel(); throw rejected(); }
}
