export type NativeCallOutcome = Readonly<{ status: "fulfilled" }> | Readonly<{ status: "rejected"; reason: unknown }>;
export interface NativeCallObservation<Binding> {
  readonly binding: Promise<Binding>;
  readonly outcome: Promise<NativeCallOutcome>;
}
export interface NativeCallRecord<Binding> {
  readonly observation: NativeCallObservation<Binding>;
  readonly original: Promise<unknown> | undefined;
  bind(value: Binding): void;
  finish(): void;
  attach(original: Promise<unknown>): void;
}
/** One native-call record. Observation has no timer, IO, cancellation, reset or
 * current-owner lookup. Rejection reasons are retained as their original objects. */
export function createNativeCallRecord<Binding>(empty: Binding): NativeCallRecord<Binding> {
  let bound = false, original: Promise<unknown> | undefined;
  let bind!: (value: Binding) => void, outcome!: (value: NativeCallOutcome) => void;
  const observation = Object.freeze({ binding: new Promise<Binding>(resolve => { bind = resolve; }),
    outcome: new Promise<NativeCallOutcome>(resolve => { outcome = resolve; }) });
  const finish = () => { if (!bound) { bound = true; bind(empty); } };
  return Object.freeze({ observation, get original() { return original; },
    bind(value: Binding) { if (bound) throw new Error("Native call binding already decided"); bound = true; bind(value); },
    finish,
    attach(value: Promise<unknown>) {
      if (original) throw new Error("Native call original result already attached");
      original = value;
      void value.then(() => { finish(); outcome(Object.freeze({ status: "fulfilled" })); },
        reason => { finish(); outcome(Object.freeze({ status: "rejected", reason })); });
    },
  });
}
