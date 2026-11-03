import type { Place } from "@tahtiapuri/validation/observing";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createSkyClient } from "@tahtiapuri/api-client";
import type { SkySnapshot, SkySelection, SkyErrorCode } from "@tahtiapuri/validation/sky";
import { createCanvasSkyMap, type SkyMapAdapter } from "./canvas-sky-map.js";
import { draftAt, requestFromDraft, sameObservation, formatObservationTime, type ObservationDraft } from "./observation-form.js";
import { ObjectCard } from "./ObjectCard.js";
import styles from "./SkyMapPanel.module.css";
const client = createSkyClient(window.tahtiapuri.sky);
const errors: Record<SkyErrorCode, string> = { INVALID_INPUT: "Aika, paikka tai kohde ei kelpaa. Tarkista tiedot.", CATALOG_UNAVAILABLE: "Paikallinen tähtiaineisto puuttuu tai sen tarkistus epäonnistui.", UNAVAILABLE: "Taivastietoja ei saatu. Voit yrittää uudelleen.", BUSY: "Edellinen karttapyyntö on vielä kesken. Yritä hetken kuluttua uudelleen." };
export function SkyMapPanel({ place, contextPending }: { place: Place | null; contextPending: boolean }) {
  const [draft, setDraft] = useState(() => draftAt(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone));
  const [snapshot, setSnapshot] = useState<SkySnapshot | null>(null), [placeLabel, setPlaceLabel] = useState("");
  const [selection, setSelection] = useState<SkySelection | null>(null), [query, setQuery] = useState("");
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null), [drawingError, setDrawingError] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null), adapter = useRef<SkyMapAdapter | null>(null);
  const epoch = useRef(0), inFlight = useRef(false), mounted = useRef(true);
  const queued = useRef<ObservationDraft | null>(null), lastInstant = useRef<string | null>(null);
  const selectRef = useRef<(id: string) => void>(() => {});
  useEffect(() => {
    mounted.current = true;
    try { if (canvas.current) adapter.current = createCanvasSkyMap(canvas.current, id => selectRef.current(id)); }
    catch { setDrawingError(true); }
    return () => { mounted.current = false; epoch.current++; queued.current = null; try { adapter.current?.dispose(); } catch {} adapter.current = null; };
  }, []);
  useEffect(() => {
    try { adapter.current?.update(snapshot, selection?.object.id ?? null); }
    catch {
      try { adapter.current?.dispose(); } catch { /* A broken drawing context must not break the catalogue UI. */ }
      adapter.current = null; setDrawingError(true);
    }
  }, [snapshot, selection]);
  const placeKey = place ? JSON.stringify(place) : "none";
  useLayoutEffect(() => {
    epoch.current++; queued.current = null; setSnapshot(null); setSelection(null); setError(null);
    if (place) {
      const next = draftAt(new Date(lastInstant.current ?? Date.now()), place.timeZone, {
        label: place.name, latitude: String(place.observer.latitudeDeg), longitude: String(place.observer.longitudeDeg), elevation: String(place.observer.elevationMeters), timeZone: place.timeZone, localTime: "", offset: "0",
      });
      setDraft(next); void load(next);
    }
  }, [placeKey]);
  function finish() {
    inFlight.current = false;
    if (!mounted.current) return;
    setPending(false); const next = queued.current; queued.current = null;
    if (next) void load(next);
  }
  function change<K extends keyof ObservationDraft>(key: K, value: string) {
    epoch.current++; setDraft(previous => ({ ...previous, [key]: value })); setSnapshot(null); setSelection(null); setError(null);
  }
  async function load(next: ObservationDraft) {
    if (inFlight.current) { queued.current = next; return; }
    let request;
    try { request = requestFromDraft(next); }
    catch { setError("Tarkista koordinaatit, aikavyöhyke ja UTC-poikkeama. Kesäajan siirtymään osuvaa puuttuvaa kellonaikaa ei hyväksytä."); return; }
    lastInstant.current = request.atUtc;
    const version = ++epoch.current;
    inFlight.current = true; setPending(true); setSnapshot(null); setSelection(null); setError(null);
    try {
      const result = await client.snapshot(request);
      if (!mounted.current || version !== epoch.current) return;
      if (result.ok && sameObservation(request, result.snapshot.context)) { lastInstant.current = result.snapshot.context.atUtc; setSnapshot(result.snapshot); setPlaceLabel(next.label.trim() || "Nimetön havaintopaikka"); }
      else setError(result.ok ? errors.UNAVAILABLE : errors[result.code]);
    } finally { finish(); }
  }
  async function select(id: string) {
    if (!snapshot || inFlight.current || contextPending) return;
    const version = ++epoch.current;
    inFlight.current = true; setPending(true); setSelection(null); setError(null);
    const observation = { atUtc: snapshot.context.atUtc, timeZone: snapshot.context.timeZone, observer: snapshot.context.observer };
    try {
      const result = await client.select({ observation, objectId: id });
      if (!mounted.current || version !== epoch.current) return;
      if (result.ok && result.selection.object.id === id && sameObservation(result.selection.context, snapshot.context)) setSelection(result.selection);
      else setError(result.ok ? errors.UNAVAILABLE : errors[result.code]);
    } finally { finish(); }
  }
  selectRef.current = id => { void select(id); };
  function now() {
    try { const next = draftAt(new Date(), draft.timeZone, draft); setDraft(next); void load(next); }
    catch { setError("Aikavyöhyke ei kelpaa. Tarkista paikan aika-asetus."); }
  }
  function shift(hours: number) {
    if (!snapshot) return;
    try {
      const next = draftAt(new Date(Date.parse(snapshot.context.atUtc) + hours * 3600000), snapshot.context.timeZone, draft);
      setDraft(next); void load(next);
    } catch { setError("Valittu aika ylittää laskennan tukeman vuosivälin 2000–2100."); }
  }
  const visibleCount = snapshot?.objects.filter(o => o.horizontal.horizon !== "below").length ?? 0;
  const lowerQuery = query.trim().toLocaleLowerCase("fi");
  const candidates = snapshot?.objects.filter(o => !lowerQuery ? o.kind !== "star" : (o.name + " " + o.id).toLocaleLowerCase("fi").includes(lowerQuery)) ?? [];
  const options = candidates.slice(0, 100);
  if (selection && !options.some(o => o.id === selection.object.id)) options.unshift(selection.object);
  return <section className={styles.panel} aria-labelledby="sky-title">
    <div className={styles.titleRow}><div><p className={styles.eyebrow}>Paikallinen tähtikartta</p><h2 id="sky-title">Taivas yläpuolellasi</h2></div><span className={styles.offline}>● Offline-laskenta</span></div>
    <form className={styles.contextForm} onSubmit={event => { event.preventDefault(); void load(draft); }}>
      <fieldset disabled={pending || contextPending || !place}><legend>Kartan aika</legend>
        <div className={styles.fields}>
          <label>Paikallinen aika<input type="datetime-local" step="1" required value={draft.localTime} onChange={e => change("localTime", e.target.value)} /></label>
          <label>UTC-poikkeama (min)<input type="number" min={-840} max={840} step={1} required value={draft.offset} onChange={e => change("offset", e.target.value)} /></label>
        </div>
        <div className={styles.actions}><button type="submit">Näytä taivas</button><button type="button" onClick={now}>Nyt</button><span>{place ? `${place.name} · ${place.timeZone}` : "Tallenna tai valitse havaintopaikka asetuksista."}</span></div>
      </fieldset>
      <p className={styles.small}>UTC-poikkeama erottaa kesäajan kaksi samannimistä kellonaikaa. Suomessa yleensä +120 talvella ja +180 kesällä.</p>
    </form>
    <div role="status" aria-label="Kartan tila" className={styles.state}>{pending ? "Haetaan paikallisia taivastietoja…" : snapshot ? `${visibleCount} kohdetta geometrisen horisontin yläpuolella tai sillä.` : "Valitse havaintopaikka asetuksista."}</div>
    {error && <p role="alert" className={styles.error}>{error} <button type="button" disabled={pending} onClick={() => { void load(draft); }}>Yritä uudelleen</button></p>}
    <div className={styles.workspace}>
      <div className={styles.chartColumn}>
        {snapshot && <div className={styles.activeContext} data-testid="active-observation"><strong>{placeLabel}</strong><span>{formatObservationTime(snapshot.context)}</span><span>{snapshot.context.observer.latitudeDeg}° / {snapshot.context.observer.longitudeDeg}° · {snapshot.context.observer.elevationMeters} m</span><div className={styles.timeActions}><button type="button" disabled={pending || contextPending} onClick={() => shift(-1)}>−1 h</button><span>{snapshot.objects.find(o => o.id === "Sun")!.horizontal.horizon === "below" ? "Aurinko horisontin alapuolella" : "Aurinko horisontilla tai sen yläpuolella"}</span><button type="button" disabled={pending || contextPending} onClick={() => shift(1)}>+1 h</button></div></div>}
        <div className={styles.mapFrame} data-map-ready={Boolean(snapshot && !drawingError)}>
          <canvas ref={canvas} className={styles.canvas} role="img" aria-label="Taivaskartta: pohjoinen ylhäällä, itä vasemmalla. Valitse kohde myös kartan kohdeluettelosta." />
          {!snapshot && !drawingError && <div className={styles.emptyMap}><span aria-hidden="true">✧</span><h3>Taivas odottaa paikkaa</h3><p>Tallenna tai valitse havaintopaikka yllä olevista asetuksista.</p></div>}
          {drawingError && <div role="alert" className={styles.emptyMap}><h3>Karttaa ei voitu piirtää</h3><p>Kohdeluettelo ja laskentatiedot ovat silti käytettävissä.</p></div>}
        </div>
        <p className={styles.small}>Katse suoraan ylöspäin: keskellä zeniitti, reunalla horisontti. Kehät 30° ja 60°. Pisteiden koko kuvaa kirkkautta, ei kulmaläpimittaa. Kartta näyttää kohteet myös päivänvalossa; sää, ilmakehä ja esteet eivät kuulu näkymään.</p>
      </div>
      <aside className={styles.detailColumn}>
        <section className={styles.finder} aria-label="Kartan kohdeluettelo"><h3>Etsi kohde</h3><label>Nimi tai tunniste<input type="search" value={query} maxLength={128} onChange={event => setQuery(event.target.value)} placeholder="Esim. Jupiter tai Sirius" disabled={!snapshot} /></label>
          <label>Kohde<select aria-label="Kartan kohde" value={selection?.object.id ?? ""} disabled={!snapshot || pending || contextPending} onChange={event => { if (event.target.value) void select(event.target.value); }}><option value="">{lowerQuery ? "Valitse hakutuloksista" : "Aurinkokunnan kohteet"}</option>{options.map(o => <option key={o.id} value={o.id}>{o.name} · {o.horizontal.altitudeDeg.toFixed(1)}°{o.horizontal.horizon === "below" ? " · horisontin alla" : ""}</option>)}</select></label>
          <p className={styles.small}>{lowerQuery ? `${candidates.length} hakutulosta; enintään 100 näkyy. Tyhjennä haku planeettoja varten.` : "Voit valita myös horisontin alapuolella olevan kohteen. Tähtiä voit etsiä nimellä."}</p>
        </section>
        <ObjectCard selection={selection} />
        {snapshot && <section className={styles.sources}><h3>Aineisto ja tarkkuus</h3><p>Astronomy Engine 2.1.19 · HYG 4.1, 5 070 tähteä (V ≤ 6).</p><p>HYG: Astronexus ja tekijät, CC BY-SA 4.0 (creativecommons.org/licenses/by-sa/4.0/). Aineisto on rajattu ja muunnettu. Lähde: github.com/astronexus/HYG-Database, hyg/CURRENT/hygdata_v41.csv; revisio c7f7f883fe678cc7680169a50ccd7dcc49b060ce.</p><p>Korkeus ja suunta näytetään 0,1°:n, Dec 0,01°:n ja RA 0,001 tunnin välein. Pyöristys ei takaa vastaavaa havaintotarkkuutta. Korkeus on geometrinen, ilman ilmakehän taittumista.</p></section>}
      </aside>
    </div>
  </section>;
}
