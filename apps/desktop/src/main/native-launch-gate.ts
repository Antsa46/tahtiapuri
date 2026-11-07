/** Main and its trusted launch worker share one linearization word.
 * COMMITTED means native stdin may have been authorized, not delivery proof. */
const CANCELLED = 1, COMMITTED = 2, MASK = CANCELLED | COMMITTED;
function word(buffer: SharedArrayBuffer): Int32Array {
  if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== 4) throw new Error("Invalid native launch gate");
  return new Int32Array(buffer);
}
export function createNativeLaunchGate(): SharedArrayBuffer { return new SharedArrayBuffer(4); }
export function nativeLaunchGateState(buffer: SharedArrayBuffer) {
  const value = Atomics.load(word(buffer), 0);
  if (value & ~MASK) throw new Error("Invalid native launch gate state");
  return Object.freeze({ cancelled: !!(value & CANCELLED), committed: !!(value & COMMITTED) });
}
export function cancelNativeLaunchGate(buffer: SharedArrayBuffer): void {
  Atomics.or(word(buffer), 0, CANCELLED);
}
/** Called only by the trusted worker immediately before the explicit stdin/EOF
 * action. Transport failure itself is not an authorization protocol. */
export function commitNativeLaunchGate(buffer: SharedArrayBuffer, deadline: bigint, now: () => bigint): boolean {
  const view = word(buffer);
  nativeLaunchGateState(buffer);
  if (now() >= deadline) { cancelNativeLaunchGate(buffer); return false; }
  if (Atomics.compareExchange(view, 0, 0, COMMITTED) !== 0) return false;
  // Preserve COMMITTED conservatively even when this second check withholds IO.
  if (now() >= deadline || nativeLaunchGateState(buffer).cancelled) {
    cancelNativeLaunchGate(buffer); return false;
  }
  return true;
}
