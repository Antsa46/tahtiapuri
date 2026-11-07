/** Main-process monotonic deadline. This check is used only before dispatch;
 * a positive exitVerified means this operation has not started a child. */
export class NativeOperationDeadlineError extends Error {
  readonly exitVerified = true;
  constructor() { super("Native operation deadline expired or invalid."); }
}
export function requireNativeOperationDeadline(deadline?: number): void {
  if (deadline !== undefined && (!Number.isFinite(deadline) || deadline <= 0 || performance.now() >= deadline))
    throw new NativeOperationDeadlineError();
}
