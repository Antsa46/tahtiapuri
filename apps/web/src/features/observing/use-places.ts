import { useEffect, useRef, useState } from "react";
import { createObservingClient } from "@tahtiapuri/api-client";
import type { ObservingErrorCode, ObservingResult, PlaceDraft, PlacesState } from "@tahtiapuri/validation/observing";
const client = createObservingClient(window.tahtiapuri.observing);
const messages: Record<ObservingErrorCode, string> = {
  INVALID_INPUT: "Tarkista paikan nimi, koordinaatit ja aikavyöhyke.", READ_FAILED: "Tallennettuja paikkoja ei voitu lukea. Tiedostoa ei korvata tyhjällä.",
  SAVE_FAILED: "Paikan tallennus ei varmistunut. Lataa paikat uudelleen ennen seuraavaa muutosta.", CONFLICT: "Tallennetut paikat ovat muuttuneet. Lataa ne uudelleen ennen muokkaamista.",
  LIMIT_REACHED: "Paikkoja voi tallentaa enintään 16.", DUPLICATE_NAME: "Samanniminen paikka on jo olemassa. Valitse toinen nimi.",
  BUSY: "Paikkojen edellinen käsittely on kesken. Lataa paikat uudelleen.", UNAVAILABLE: "Paikkojen yhteys ei ole käytettävissä. Lataa paikat uudelleen.",
};
export function usePlaces() {
  const [state, setState] = useState<PlacesState | null>(null), [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null), [locked, setLocked] = useState(true);
  const busy = useRef(false), mounted = useRef(true), current = useRef<PlacesState | null>(null);
  async function run(action: () => Promise<ObservingResult>): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true; setPending(true); setError(null);
    try {
      const result = await action();
      if (!mounted.current) return false;
      if (result.ok) { current.current = result.state; setState(result.state); setLocked(false); return true; }
      setError(messages[result.code]);
      if (!["INVALID_INPUT", "DUPLICATE_NAME", "LIMIT_REACHED"].includes(result.code)) setLocked(true);
      return false;
    } finally { busy.current = false; if (mounted.current) setPending(false); }
  }
  useEffect(() => {
    mounted.current = true; void run(() => client.read());
    return () => { mounted.current = false; };
  }, []);
  async function save(id: string | null, place: PlaceDraft) {
    if (!current.current || locked) return false;
    return run(() => client.save({ expectedRevision: current.current!.revision, id, place }));
  }
  async function remove(id: string) {
    if (!current.current || locked) return false;
    return run(() => client.remove({ expectedRevision: current.current!.revision, id }));
  }
  async function activate(id: string) {
    if (!current.current || locked) return false;
    return run(() => client.activate({ expectedRevision: current.current!.revision, id }));
  }
  return { state, pending, error, locked, save, remove, activate, reload: () => run(() => client.read()) };
}
export type PlacesModel = ReturnType<typeof usePlaces>;
