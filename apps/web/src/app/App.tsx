import { DevelopmentSettings } from "../features/development/DevelopmentSettings.js";
import { AssistantPanel } from "../features/assistant/AssistantPanel.js";
import { SkyMapPanel } from "../features/sky-map/SkyMapPanel.js";
import { useEffect, useState } from "react";
import { createRuntimeClient } from "@tahtiapuri/api-client";
import styles from "./App.module.css";
const client = createRuntimeClient(window.tahtiapuri);
export function App() {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  async function checkStatus() {
    setState("loading");
    const result = await client.getStatus();
    setState(result.ok ? "ready" : "error");
  }
  useEffect(() => { void checkStatus(); }, []);
  return <main className={styles.page}>
    <header className={styles.header}><span className={styles.brand}>✦ Tähtiapuri</span><span className={styles.version}>Oma ikkuna yötaivaalle</span></header>
    <section className={styles.intro}><p className={styles.eyebrow}>Pysähdy hetkeksi. Katso ylöspäin.</p><h1>Tänään taivaalla.</h1><p>Valitse paikka ja hetki. Tutki taivasta omalta koneeltasi.</p></section>
    <SkyMapPanel />
    <div className={styles.tools}><AssistantPanel /><DevelopmentSettings /></div>
    <footer className={styles.footer}>
      <span role="status" aria-label="Yhteyden tila" aria-live="polite">{state === "ready" ? "Yhteys toimii" : state === "error" ? "Yhteyttä ei saatu" : "Tarkistetaan yhteyttä…"}</span>
      <button disabled={state === "loading"} onClick={() => { void checkStatus(); }}>Tarkista yhteys uudelleen</button>
      <p>Kartta lasketaan paikallisesti. Keskustelumalli ei vielä käytä kartan tietoja. Säätietoja ei haeta.</p>
    </footer>
  </main>;
}
