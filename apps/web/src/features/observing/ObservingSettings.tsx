import { useState } from "react";
import type { Place } from "@tahtiapuri/validation/observing";
import type { PlacesModel } from "./use-places.js";
import styles from "./ObservingSettings.module.css";
type Form = { id: string | null; name: string; latitude: string; longitude: string; elevation: string; timeZone: string };
const empty = (): Form => ({ id: null, name: "", latitude: "", longitude: "", elevation: "0", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
export function ObservingSettings({ model }: { model: PlacesModel }) {
  const [editing, setEditing] = useState(false), [form, setForm] = useState<Form>(empty), [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const active = model.state?.places.find(p => p.id === model.state!.activePlaceId) ?? null;
  const showEditor = editing || model.state?.places.length === 0;
  function create() { setForm(empty()); setFormError(null); setConfirmDelete(null); setEditing(true); }
  function edit(place: Place) {
    setForm({ id: place.id, name: place.name, latitude: String(place.observer.latitudeDeg), longitude: String(place.observer.longitudeDeg), elevation: String(place.observer.elevationMeters), timeZone: place.timeZone });
    setFormError(null); setConfirmDelete(null); setEditing(true);
  }
  async function save() {
    if (![form.latitude, form.longitude, form.elevation].every(v => v.trim() !== "" && Number.isFinite(Number(v))) || !form.name.trim()) { setFormError("Täytä paikan nimi ja koordinaatit."); return; }
    setFormError(null);
    const ok = await model.save(form.id, { name: form.name.trim(), timeZone: form.timeZone.trim(), observer: { latitudeDeg: Number(form.latitude), longitudeDeg: Number(form.longitude), elevationMeters: Number(form.elevation) } });
    if (ok) { setEditing(false); setForm(empty()); setConfirmDelete(null); }
  }
  return <section className={styles.panel} aria-labelledby="places-title">
    <div className={styles.heading}><div><p className={styles.eyebrow}>Asetukset · paikalliset tiedot</p><h2 id="places-title">Havaintopaikat</h2></div><span>{model.state?.places.length ?? 0} / 16</span></div>
    <div role="status" aria-label="Paikkojen tila">{model.pending ? "Käsitellään paikkoja…" : model.locked ? "Paikkojen käyttö odottaa onnistunutta lukua." : active ? `Aktiivinen paikka: ${active.name}` : "Valitse havaintopaikka tai tallenna uusi."}</div>
    {model.error && <p role="alert" className={styles.error}>{model.error}</p>}
    {model.error && <button type="button" disabled={model.pending} onClick={() => { void model.reload(); }}>Lataa paikat uudelleen</button>}
    <fieldset disabled={model.pending || model.locked}>
      <div className={styles.chooser}><label>Havaintopaikka<select aria-label="Tallennettu havaintopaikka" value={model.state?.activePlaceId ?? ""} disabled={editing} onChange={e => { if (e.target.value) void model.activate(e.target.value); }}><option value="">Valitse havaintopaikka</option>{model.state?.places.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <div className={styles.actions}><button type="button" onClick={create} disabled={(model.state?.places.length ?? 0) >= 16}>Lisää paikka</button><button type="button" disabled={!active} onClick={() => { if (active) edit(active); }}>Muokkaa paikkaa</button><button type="button" disabled={!active} onClick={() => { if (active) { setConfirmDelete(active.id); setEditing(false); } }}>Poista paikka</button></div>
      </div>
      {showEditor && <form onSubmit={e => { e.preventDefault(); void save(); }}>
        <h3>{form.id ? "Muokkaa havaintopaikkaa" : "Uusi havaintopaikka"}</h3>
        <div className={styles.fields}>
          <label>Paikan nimi<input required maxLength={64} value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} /></label>
          <label>Leveysaste °<input required type="number" min={-90} max={90} step="any" value={form.latitude} onChange={e => setForm(p => ({ ...p, latitude: e.target.value }))} /></label>
          <label>Pituusaste °<input required type="number" min={-180} max={180} step="any" value={form.longitude} onChange={e => setForm(p => ({ ...p, longitude: e.target.value }))} /></label>
          <label>Korkeus m<input required type="number" min={-500} max={10000} step="any" value={form.elevation} onChange={e => setForm(p => ({ ...p, elevation: e.target.value }))} /></label>
          <label>Aikavyöhyke<input required maxLength={64} value={form.timeZone} onChange={e => setForm(p => ({ ...p, timeZone: e.target.value }))} /></label>
        </div>
        <p className={styles.note}>Pohjoinen leveys ja itäinen pituus ovat positiivisia. Aikavyöhyke on IANA-nimi, esimerkiksi Europe/Helsinki.</p>
        {formError && <p role="alert" className={styles.error}>{formError}</p>}
        <div className={styles.actions}><button type="submit">Tallenna ja käytä paikkaa</button>{model.state && model.state.places.length > 0 && <button type="button" onClick={() => { setEditing(false); setForm(empty()); setFormError(null); }}>Peru muokkaus</button>}</div>
      </form>}
      {confirmDelete && <div role="alertdialog" aria-label="Poista havaintopaikka" className={styles.confirm}>
        <p>Poistetaanko {model.state?.places.find(p => p.id === confirmDelete)?.name}? Aktiivisen paikan poiston jälkeen valitset paikan uudelleen.</p>
        <div className={styles.actions}><button type="button" onClick={() => { void model.remove(confirmDelete).then(ok => { if (ok) { setConfirmDelete(null); setForm(empty()); } }); }}>Vahvista poisto</button><button type="button" onClick={() => setConfirmDelete(null)}>Peru poisto</button></div>
      </div>}
    </fieldset>
    <p className={styles.note}>Paikat ja viimeksi käytetty valinta säilyvät vain tämän sovelluksen paikallisissa tiedoissa. Paikan muutos ei käynnistä säähakua.</p>
  </section>;
}
