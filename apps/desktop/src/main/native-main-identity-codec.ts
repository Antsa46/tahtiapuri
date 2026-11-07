import type { NativeMainIdentity } from "./native-development-bootstrap.js";

/** Exact native text protocol. ASCII conversion must never erase high bits. */
export function decodeNativeMainIdentity(bytes: Uint8Array, expectedPid: number): NativeMainIdentity {
  if (!(bytes instanceof Uint8Array) || bytes.buffer instanceof SharedArrayBuffer || bytes.byteLength > 128
    || !Number.isSafeInteger(expectedPid) || expectedPid < 1 || expectedPid > 0xffffffff)
    throw new Error("Invalid native Main identity receipt");
  const copy = Buffer.from(bytes);
  try {
    if (copy.some(byte => byte > 0x7f)) throw new Error("Non-ASCII native Main identity receipt");
    const match = /^\{"pid":([1-9][0-9]{0,9}),"creationTime":"([a-f0-9]{16})"\}\r?\n$/.exec(copy.toString("utf8"));
    if (!match || Number(match[1]) !== expectedPid) throw new Error("Invalid native Main identity receipt");
    const creationTime = BigInt("0x" + match[2]);
    if (creationTime === 0n) throw new Error("Invalid native Main creation time");
    return Object.freeze({ pid: expectedPid, creationTime });
  } finally { copy.fill(0); }
}
