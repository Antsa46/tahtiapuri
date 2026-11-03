import { isObservingResult, isObservingInput, type ObservingBridge, type ObservingResult, type ObservingOperation, type PlaceSave, type PlaceChoice } from "@tahtiapuri/validation/observing";
export function createObservingClient(bridge: ObservingBridge | undefined) {
  async function call(operation: ObservingOperation, input?: PlaceSave | PlaceChoice): Promise<ObservingResult> {
    if (!isObservingInput(operation, input)) return { ok: false, code: "INVALID_INPUT" };
    if (!bridge) return { ok: false, code: "UNAVAILABLE" };
    try {
      const result: unknown = operation === "observing.read" ? await bridge.read() : operation === "observing.save" ? await bridge.save(input as PlaceSave)
        : operation === "observing.remove" ? await bridge.remove(input as PlaceChoice) : await bridge.activate(input as PlaceChoice);
      return isObservingResult(result) ? result : { ok: false, code: "UNAVAILABLE" };
    } catch { return { ok: false, code: "UNAVAILABLE" }; }
  }
  return { read: () => call("observing.read"), save: (input: PlaceSave) => call("observing.save", input), remove: (input: PlaceChoice) => call("observing.remove", input), activate: (input: PlaceChoice) => call("observing.activate", input) };
}
