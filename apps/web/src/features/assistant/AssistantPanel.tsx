import { useEffect, useState } from "react";
import { isAssistantResult, type JobView, type ComputeBackend, type ModelErrorCode } from "@tahtiapuri/validation/assistant";
import styles from "./AssistantPanel.module.css";
const messages: Record<ModelErrorCode, string> = {
  BUSY: "Työjono on täynnä.", CANCELLED: "Työ peruttiin.", OUT_OF_MEMORY: "Muisti ei riittänyt mallin ajamiseen.",
  MODEL_INVALID: "Mallitiedosto puuttuu tai sen tarkiste ei täsmää.",
  ENGINE_UNAVAILABLE: "Mallimoottori ei käynnistynyt. Tarkista mallin ja valitun laskentataustan asennus.",
  ENGINE_CRASHED: "Malliprosessi pysähtyi. Voit yrittää uudella kysymyksellä.",
  TIMEOUT: "Mallin aikaraja ylittyi.", INVALID_INPUT: "Kysymys tai työn tunniste ei kelpaa.",
};
export function AssistantPanel() {
  const bridge = window.tahtiapuri.assistant;
  const [prompt, setPrompt] = useState("Mitä kannattaa huomioida Jupiterin havainnoinnissa paljain silmin?");
  const [backend, setBackend] = useState<ComputeBackend>("cpu");
  const [job, setJob] = useState<JobView | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<ModelErrorCode | null>(null);
  const busy = requesting || Boolean(job && ["queued", "loading", "running"].includes(job.state));
  useEffect(() => {
    if (!bridge || !job || !["queued", "loading", "running"].includes(job.state)) return;
    let alive = true, polling = false;
    const id = job.id;
    const timer = setInterval(() => {
      if (polling) return; polling = true;
      void bridge.get(id).then(result => {
        if (!alive) return;
        if (isAssistantResult(result) && result.ok) setJob(result.job);
        else { setError("ENGINE_UNAVAILABLE"); setJob(null); }
      }).catch(() => { if (alive) { setError("ENGINE_UNAVAILABLE"); setJob(null); } }).finally(() => { polling = false; });
    }, 300);
    return () => { alive = false; clearInterval(timer); };
  }, [bridge, job?.id, job?.state]);
  if (!bridge) return null;
  async function submit() {
    if (!bridge || busy) return; setRequesting(true); setError(null); setJob(null);
    try {
      const result = await bridge.submit({ prompt, backend });
      if (isAssistantResult(result) && result.ok) setJob(result.job);
      else setError(isAssistantResult(result) && !result.ok ? result.code : "ENGINE_UNAVAILABLE");
    } catch { setError("ENGINE_UNAVAILABLE"); } finally { setRequesting(false); }
  }
  async function cancel() {
    if (!bridge || !job) return;
    const result = await bridge.cancel(job.id).catch(() => null);
    if (isAssistantResult(result) && result.ok) setJob(result.job);
  }
  return <section className={styles.panel} aria-labelledby="model-title" data-job-id={job?.id}>
    <h2 id="model-title">Kysy paikalliselta mallilta</h2>
    <p>Qwen3 4B · Kokeilu ei vielä käytä tähtilaskentaa tai säätietoja.</p>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label>Kysymys<textarea aria-label="Kysymys paikalliselle mallille" maxLength={2000} value={prompt} disabled={busy} onChange={event => setPrompt(event.target.value)} /></label>
      <label>Laskentatapa<select aria-label="Laskentatapa" value={backend} disabled={busy} onChange={event => setBackend(event.target.value as ComputeBackend)}>
        <option value="cpu">CPU</option><option value="cuda">CUDA / NVIDIA</option>
      </select></label>
      <div className={styles.buttons}>
        <button type="submit" disabled={busy || !prompt.trim()}>Kysy mallilta</button>
        {busy && job && <button type="button" onClick={() => { void cancel(); }}>Peru työ</button>}
      </div>
    </form>
    <div role="status" aria-label="Mallin tila">
      {job?.state === "loading" ? "Ladataan ja tarkistetaan mallia…" : job?.state === "queued" ? "Työ odottaa…" : job?.state === "running" ? "Malli vastaa…" : job?.state === "completed" ? "Vastaus valmis" : ""}
      {(error || job?.error) && <p role="alert">{messages[(error ?? job?.error)!]}</p>}
    </div>
    {job?.info && <p className={styles.info}>Todellinen ajotapa: {job.info.backend.toUpperCase()} · GPU-kerroksia: {job.info.gpuLayers} · Konteksti: {job.info.contextSize}</p>}
    {job?.text && <p className={styles.answer} data-testid="model-answer">{job.text}</p>}
  </section>;
}
