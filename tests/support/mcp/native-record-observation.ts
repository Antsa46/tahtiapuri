import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createHash } from "node:crypto";

const formats = {
  session: { magic: "TMCSES1\0", version: 1, bytes: 1024 },
  journal: { magic: "TMCJRN2\0", version: 2, bytes: 1024 },
  "clean-intent": { magic: "TMCCLS1\0", version: 1, bytes: 2048 },
  "clean-completion": { magic: "TMCCLD1\0", version: 1, bytes: 1024 },
} as const;
export type NativeRecordKind = keyof typeof formats;

function shape(stat: BigIntStats, bytes: number): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size !== BigInt(bytes))
    throw new Error("Invalid native record shape");
}
function same(left: BigIntStats, right: BigIntStats): void {
  for (const key of ["dev", "ino", "size", "nlink", "mtimeNs", "ctimeNs"] as const)
    if (left[key] !== right[key]) throw new Error("Native record changed during observation");
}

/** Test-only, bounded, read-only observation. This is not a Win32 ACL/token,
 * process/Job, canonical native-codec or release-authority proof. The caller
 * independently compares context fields. All file handles close before return. */
export async function observeNativeRecord(path: string, kind: NativeRecordKind) {
  const format = Object.hasOwn(formats, kind) ? formats[kind] : undefined;
  if (!format) throw new Error("Unknown native record format");
  const named = await lstat(path, { bigint: true }); shape(named, format.bytes);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat({ bigint: true }); shape(before, format.bytes); same(named, before);
    // One extra byte detects growth without reading an unbounded file to EOF.
    const buffer = Buffer.alloc(format.bytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const result = await file.read(buffer, count, buffer.length - count, null);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (count !== format.bytes) throw new Error("Invalid native record length");
    const after = await file.stat({ bigint: true }), current = await lstat(path, { bigint: true });
    shape(after, format.bytes); shape(current, format.bytes); same(before, after); same(after, current);
    const bytes = buffer.subarray(0, format.bytes), checksumAt = format.bytes - 32;
    if (!bytes.subarray(0, 8).equals(Buffer.from(format.magic, "ascii"))
      || bytes.readUInt32LE(8) !== format.version || bytes.readUInt32LE(12) !== format.bytes)
      throw new Error("Invalid native record header");
    if (!bytes.subarray(checksumAt).equals(createHash("sha256").update(bytes.subarray(0, checksumAt)).digest()))
      throw new Error("Invalid native record checksum");
    return { bytes, stat: before };
  } finally { await file.close(); }
}
