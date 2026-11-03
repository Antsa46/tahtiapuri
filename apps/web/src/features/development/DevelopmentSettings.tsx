import { useEffect, useState } from "react";
import { isDevelopmentResult, type DevelopmentStatus } from "@tahtiapuri/validation/development";
import styles from "./DevelopmentSettings.module.css";
export function DevelopmentSettings() {
  const bridge = window.tahtiapuri.development;
  const [status, setStatus] = useState<DevelopmentStatus | null>(null);
  const [changing, setChanging] = useState(false);
  const [requested, setRequested] = useState<boolean | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!bridge) return;
    let alive = true, polling = false;
    async function refresh() {
      if (polling) return; polling = true;
      try {
        const value = await bridge!.getStatus();
        if (alive && isDevelopmentResult(value) && value.ok && "status" in value) setStatus(value.status);
      } finally { polling = false; }
    }
    void refresh().catch(() => {});
    const timer = setInterval(() => { void refresh().catch(() => {}); }, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [bridge]);
  if (!bridge) return null;
  async function toggle(enabled: boolean) {
    if (!bridge || changing) return;
    setChanging(true); setRequested(enabled); setError(false);
    try {
      const value = await bridge.setEnabled(enabled);
      if (isDevelopmentResult(value) && value.ok && "status" in value) setStatus(value.status);
      else setError(true);
    } catch { setError(true); } finally { setChanging(false); setRequested(null); }
  }
  return <section className={styles.panel} aria-labelledby="development-title">
    <h2 id="development-title">Asetukset · Kehitystyökalut</h2>
    <label><input type="checkbox" aria-label="Salli Codex/MCP-kehitysyhteys"
      checked={requested ?? status?.enabled ?? false} disabled={changing || status === null}
      onChange={event => { void toggle(event.target.checked); }} /> Salli Codex/MCP-kehitysyhteys</label>
    <p role="status" aria-label="Kehitysyhteyden tila">{status?.enabled
      ? status.connected ? "Kehitysyhteys käytössä" : "Kehitysyhteys sallittu, ei asiakasta"
      : "Kehitysyhteys pois päältä"}</p>
    <p>Kehitystyökalu saa vain sille annetun mallikokeen. Pois kytkeminen katkaisee yhteyden ja peruu sen kokeet. Yhteys alkaa suljettuna jokaisella käynnistyksellä.</p>
    {error && <p role="alert">Kehitysyhteyden muuttaminen epäonnistui.</p>}
  </section>;
}
