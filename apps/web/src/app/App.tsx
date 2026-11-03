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
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <span className={styles.brand}>✦ Tähtiapuri</span>
        <span className={styles.version}>Kokeiluversio</span>
      </header>
      <section className={styles.intro}>
        <p className={styles.eyebrow}>Oma hetki tähtitaivaan äärellä</p>
        <h1>Ilta alkaa tästä.</h1>
        <p className={styles.lead}>Paikallinen apuri havaintoiltojen suunnitteluun.</p>
      </section>
      <section className={styles.card} aria-labelledby="status-title">
        <div className={styles.moon} aria-hidden="true" />
        <div>
          <h2 id="status-title">Tähtiapuri heräilee</h2>
          <p>Kartta ja keskusteleva avustaja rakentuvat seuraavissa vaiheissa.
            Nyt varmistamme, että sovelluksen paikallinen yhteys toimii.</p>
          <p className={styles.status} role="status" aria-live="polite">
            {state === "ready" ? "Yhteys toimii" : state === "error" ? "Yhteyttä ei saatu" : "Tarkistetaan yhteyttä…"}
          </p>
          <button disabled={state === "loading"} onClick={() => { void checkStatus(); }}>
            Tarkista yhteys uudelleen
          </button>
        </div>
      </section>
      <footer className={styles.footer}>Tämä kehitysrunko ei vielä lataa kielimallia tai hae säätietoja.</footer>
    </main>
  );
}
