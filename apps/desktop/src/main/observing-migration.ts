import { createHash } from "node:crypto";
import { isPlacesState } from "@tahtiapuri/validation/observing";
import { exactKeys, isRecord } from "@tahtiapuri/validation/public";

export type ObservingMigrationPlan =
  | { kind: "copy"; bytes: Buffer }
  | { kind: "already-present" }
  | { kind: "no-source" }
  | { kind: "blocked"; reason: "invalid-source" | "invalid-destination" | "conflicting-destination" };

type Snapshot = { kind: "absent" } | { kind: "invalid" } | { kind: "valid"; bytes: Buffer };
const MAX_BYTES = 32_768;

/**
 * Storage v1 is owned by docs/architecture/observing-places.md and the backend's
 * JsonPlacesRepository. This small reader validates relocation snapshots with
 * the same envelope, checksum and public state contract; it preserves raw bytes.
 */
function snapshot(bytes: Uint8Array | null): Snapshot {
  if (bytes === null) return { kind: "absent" };
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) return { kind: "invalid" };
  const owned = Buffer.from(bytes);
  try {
    const value: unknown = JSON.parse(owned.toString("utf8"));
    if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "state", "sha256"]) || value.schemaVersion !== 1
      || !isPlacesState(value.state) || value.sha256 !== createHash("sha256").update(JSON.stringify(value.state)).digest("hex")) return { kind: "invalid" };
    return { kind: "valid", bytes: owned };
  } catch { return { kind: "invalid" }; }
}

/** Pure preflight only: a plan authorizes no filesystem or lifecycle operation. */
export function planObservingMigration(sourceBytes: Uint8Array | null, destinationBytes: Uint8Array | null): ObservingMigrationPlan {
  const source = snapshot(sourceBytes), destination = snapshot(destinationBytes);
  if (source.kind === "invalid") return { kind: "blocked", reason: "invalid-source" };
  if (destination.kind === "invalid") return { kind: "blocked", reason: "invalid-destination" };
  if (source.kind === "absent") return { kind: "no-source" };
  if (destination.kind === "absent") return { kind: "copy", bytes: source.bytes };
  // Even equivalent valid JSON with different bytes remains an explicit conflict.
  return source.bytes.equals(destination.bytes) ? { kind: "already-present" }
    : { kind: "blocked", reason: "conflicting-destination" };
}
