import { isCapability } from "@tahtiapuri/validation/development";
import type { NativeLaunchTicket } from "./native-development-admission.js";

export const NATIVE_BOOTSTRAP_BYTES = 96;
export const NATIVE_PIPE_PREFIX = "\\\\.\\pipe\\tahtiapuri-native-mcp-";
const magic = Buffer.from([84, 77, 66, 79, 79, 84, 49, 0]);
export type NativeMainIdentity = Readonly<{ pid: number; creationTime: bigint }>;
export type NativeBootstrap = Readonly<{ main: NativeMainIdentity; pipeNonce: string; ticket: NativeLaunchTicket }>;
const nonce = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);

/** creationTime must be the exact Windows FILETIME from a trusted process-handle
 * query. JS uptime, Date and rounded UI process metrics are not this identity. */
export function encodeNativeBootstrap(value: NativeBootstrap): Buffer {
  if (!Number.isInteger(value.main.pid) || value.main.pid < 1 || value.main.pid > 0xffffffff
    || typeof value.main.creationTime !== "bigint" || value.main.creationTime < 1n || value.main.creationTime > 0xffffffffffffffffn
    || !nonce(value.pipeNonce) || !nonce(value.ticket.generation) || !isCapability(value.ticket.token))
    throw new Error("Invalid native bootstrap.");
  const bytes = Buffer.alloc(NATIVE_BOOTSTRAP_BYTES); magic.copy(bytes);
  bytes.writeUInt32LE(1, 8); bytes.writeUInt32LE(NATIVE_BOOTSTRAP_BYTES, 12);
  bytes.writeUInt32LE(value.main.pid, 16); bytes.writeBigUInt64LE(value.main.creationTime, 24);
  Buffer.from(value.pipeNonce, "hex").copy(bytes, 32); Buffer.from(value.ticket.generation, "hex").copy(bytes, 48);
  Buffer.from(value.ticket.token, "hex").copy(bytes, 64); return bytes;
}
export function decodeNativeBootstrap(bytes: Buffer): NativeBootstrap {
  if (bytes.length !== NATIVE_BOOTSTRAP_BYTES || !bytes.subarray(0, 8).equals(magic)
    || bytes.readUInt32LE(8) !== 1 || bytes.readUInt32LE(12) !== NATIVE_BOOTSTRAP_BYTES || bytes.readUInt32LE(20) !== 0)
    throw new Error("Invalid native bootstrap header.");
  const value: NativeBootstrap = Object.freeze({ main: Object.freeze({ pid: bytes.readUInt32LE(16), creationTime: bytes.readBigUInt64LE(24) }),
    pipeNonce: bytes.subarray(32, 48).toString("hex"), ticket: Object.freeze({ generation: bytes.subarray(48, 64).toString("hex"), token: bytes.subarray(64, 96).toString("hex") }) });
  // Validates the identity too, and keeps canonical re-encoding identical.
  if (!encodeNativeBootstrap(value).equals(bytes)) throw new Error("Invalid native bootstrap identity."); return value;
}
