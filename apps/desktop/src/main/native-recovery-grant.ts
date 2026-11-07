/** Explicit versioned stdin frame for descriptor recovery, followed by EOF.
 * Public, fixed bytes: not a secret and not proof of revocable delivery.
 * A broken pipe after all eight bytes may still authorize native recovery.
 * Requires the matching native helper; old empty-EOF helpers are incompatible. */
export function createNativeRecoveryGrant(): Buffer {
  return Buffer.from("THREC001", "ascii");
}
