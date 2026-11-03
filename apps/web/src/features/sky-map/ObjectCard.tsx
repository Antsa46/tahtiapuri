import type { SkySelection } from "@tahtiapuri/validation/sky";
import { formatObservationTime } from "./observation-form.js";
import styles from "./SkyMapPanel.module.css";
const directions: Record<string, string> = { N: "pohjoinen", NE: "koillinen", E: "itä", SE: "kaakko", S: "etelä", SW: "lounas", W: "länsi", NW: "luode" };
export function ObjectCard({ selection }: { selection: SkySelection | null }) {
  if (!selection) return <section className={styles.objectCard} aria-label="Kohdetiedot"><span className={styles.eyebrow}>Tutki taivasta</span><h3>Valitse kohde</h3><p>Napsauta pistettä kartalla tai etsi kohde luettelosta.</p></section>;
  const object = selection.object, h = object.horizontal, e = object.equatorial;
  return <section className={styles.objectCard} aria-label="Kohdetiedot" data-object-id={object.id}>
    <span className={styles.eyebrow}>{object.kind === "star" ? "Tähti" : object.kind === "planet" ? "Planeetta" : object.kind === "moon" ? "Kuu" : "Aurinko"} · {object.id}</span>
    <h3>{object.name}</h3>
    <p className={styles.horizon}>{h.horizon === "below" ? "Horisontin alapuolella" : h.horizon === "on" ? "Geometrisella horisontilla" : "Horisontin yläpuolella"}</p>
    <dl className={styles.facts}>
      <div><dt>Korkeus</dt><dd>{h.altitudeDeg.toFixed(1)}°</dd></div>
      <div><dt>Suunta / ats.</dt><dd>{h.azimuthDeg === null ? "Ei määritelty" : `${directions[h.direction!]} · ${h.azimuthDeg.toFixed(1)}°`}</dd></div>
      <div><dt>RA</dt><dd>{e.raHours.toFixed(3)} h</dd></div>
      <div><dt>Dec</dt><dd>{e.decDeg.toFixed(2)}°</dd></div>
      <div><dt>Magnitudi V</dt><dd>{object.magnitude.value === null ? "Ei saatavilla" : object.magnitude.value.toFixed(2)}</dd></div>
    </dl>
    <p className={styles.small}>{object.magnitude.kind === "catalog-v" ? "Katalogimagnitudi; muuttuvilla tähdillä kirkkaus voi poiketa." : "Geosentrinen kirkkausmalli ilman ilmakehän himmennystä."}</p>
    <p className={styles.small}>{formatObservationTime(selection.context)}</p>
    <p className={styles.small}>Laskennan lähde: {object.sourceId}<br />Magnitudin lähde: {object.magnitude.sourceId}<br />RA/Dec: ajankohdan todellinen ekvaattori.</p>
    {object.kind === "sun" && <p className={styles.sunWarning}>Älä katso Aurinkoon suoraan tai optisella välineellä ilman asianmukaista aurinkosuodatinta.</p>}
  </section>;
}
