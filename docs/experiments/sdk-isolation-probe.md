# SDK:n ja binäärikoelapsen eristyskoe

T09c / #26 jatkaa [Electron Node -kokeen](electron-isolation-probe.md)
AppContainer-polusta. SDK:n importti, julkinen CPU-alustus ja erillinen
instrumentoitu binäärilapsikoe ovat eri näyttöjä. GGUF-painoja, generointia,
CUDAa, käyttäjäaineistoa tai sääverkkoa ei käytetä. #24:n verkkonäyttö ja
LPAC:n nykyiset esteet pysyvät avoimina.

## Paketti ja toistaminen

Projektijuuresta Windows PowerShellissä:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\e2e\isolation\run.ps1 -Probe sdk
```

Koe käyttää olemassa olevaa lukittua Electron-arkistoa ja node-llama-cpp
3.22.2:n paikallista asennusta sekä @node-llama-cpp/win-x64 3.22.2:ta.
Mitään ei asenneta tai ladata. build=never ja skipDownload=true asetetaan
julkisessa CPU-kutsussa. GPU-vaihtoehto on yksiselitteisesti false.

package-stager.mjs kopioi nykyiset riippuvuudet NPM-rakenteeseen, säilyttää
ristiriitaiset versiot tarvittaessa sisäkkäisinä ja tarkistaa jokaisen
riippuvuusreunan alkuperäistä resoluutiota vasten. Lähdejuuret sallitaan vain
projektin node_modules-puun sisältä. Alkuperäisiä package.json-/SDK-tiedostoja
ei muuteta; kopioiden lähde- ja kohdetarkisteita verrataan. PNPM:n source-
hardlinkit eivät siirry koepakettiin. Sisäiset reparse-polut, painotiedostot,
.git ja paikalliset SDK-build/cache-tuotokset rajataan pois tai hylätään.
Muista alustoista ja GPU-binaareista ei tehdä koeversioita.

Enimmäisrajat ovat 20 000 riippuvuustiedostoa ja 1 GiB. Testihost tarkistaa
koko SDK-koepuun (enintään 25 000 solmua) ennen grantteja; pitkä Win32-polku
käsitellään tiedosto-APIssa extended-muodossa. Alkuperäisen hakemiston tai
asemajuuren oikeuksia ei muuteta. Tarkat pakettilistat, kopiotarkisteet ja
polut jäävät .artifacts/tests/isolation/sdk-runs/-puuhun.

## Instrumentoinnin näyttöraja

Asennetun SDK:n Windows CPU getLlama-polku ei kutsu testBindingBinarya.
Ensin tehdään tavallinen getLlama CPU-alustus ja dispose ilman fork-hookia.
Sen jälkeen kutsutaan erikseen SDK:n alkuperäistä testBindingBinary.js-apuria.
Tämä sisäinen testiriippuvuus on sidottu SDK-versioon ja tiedoston SHA-256:een;
sitä ei viedä sovelluksen tuotantorajapintaan eikä paketoida yhdeksi bundlen
osaksi. Apurin oma tiedostonimitarkistus ja lähderakenne säilyvät.

Ennen SDK-importtia guard vaatii Electronin ESM-resoluutioksi täsmälleen
`electron:electron`. Se tarkistaa nykyisen apurin käyttämän ESM-polun, jotta
koe ei putoa npm:n Electron-asennuswrapperiin. Tämä ei ole yleinen CommonJS-
resoluution tai kaikkien riippuvuuksien tiedostopääsyn eristys. Guardin,
eheyden tai instrumentoinnin virhe pysäyttää kokeen. Niitä tai havaittua
oikeusrajan ylitystä ei luokitella SDK-yhteensopivuusvirheeksi myöskään
samanaikaisen SDK-virheen vuoksi.

Erillisessä lapsikokeessa vain SDK:n odotettu fork instrumentoidaan:
execArgv sisältää kaksi sovittua preserve-symlinks-optiota ja kiinteän oman
child-policy-preload.cjs:n. Env/stdio ja varsinainen SDK-testitiedosto
säilyvät. Preload mittaa lapsessa sallitun paketin luvun ja scratch-kirjoituksen
sekä private-luvun/kirjoituksen ja moduulitiedoston muuttamisen. Tulokset
kulkevat SDK:n IPC:llä parentille; preload ei avaa verkkoa tai muita työkaluja.

SDK:n ready-viestin välitys odottaa asynkronisesti yhden host-kuittauksen.
Host tarkistaa oikean Jobin jäsenluettelosta yhden eri lapsen prosessikahvan,
image-polun, AppContainer-SID:n, capabilityt, integrityn ja täsmällisen
Job-jäsenyyden. Tarkistus tapahtuu lapsen JS-käynnistyksen jälkeen ja ennen
binäärin latauksen start-viestiä. Tämä ei ole ennen ensimmäistä käskyä tehty
lapsitarkistus. SDK-parentin alkuperäinen token tarkistetaan ennen ResumeThreadiä.

Kuittaus on kokeen nonceen ja PID:hen sidottu yksi viesti vain hostin
kirjoittamassa stdin-putkessa. Workerille periytyy vain sen lukupää.
Owner-liveness on eri putki; kumpikaan kirjoituspää ei periydy SDK-workerille.
Host ei avaa workerin muokattavaa scratch-polkua tarkistuksen jälkeen.

SDK-workerin stdout on erillinen putki. Host välittää sen rajattuina
worker-output-kehyksinä. Kerääjä merkitsee viestin alkuperän ja estää workeria
tuottamasta hostin token-/Job- tai siivousrivejä. Hyväksyntä edellyttää
hostin omaa inspected-child-riviä, oikeaa PID:tä sekä SDK:n ready/loaded/done-
protokollaa ja poistumista. Pelkkä apurin true-tulos tai timeout ei riitä.

## Matriisi ja elinkaari

Suojaamaton kontrolli vaaditaan ensin. Kontrollissa ja AC:ssa tehdään normaali
ajo, puuttuvan binäärin hallittu virhe sekä owner-loss elävän, ready-vaiheessa
odottavan SDK-lapsen aikana. Owner-loss ei teeskentele valmistunutta
binääritestiä. Native Job sulkee prosessipuun ja yhteinen siivousapu varmistaa
omat PID:t, profiilin ja staged-puun. Siivousvirhe tai odottamaton oikeuksien
laajeneminen keskeyttää matriisin. Toistettava SDK-yhteensopivuuseste kirjataan
erilleen onnistuneesta polusta ja ajamatta jääneistä kokeista.

Lapsikoe sisältää preloadin ja ready-viestin viiveen. Sen tulos ei ole
instrumentoimattoman tuotantoforkin tai julkisen CPU-kutsun automaattisen
binääritarkistuksen todiste. Verkon, koko sovelluksen ja oikean mallin
hyväksymisportit säilyvät erillisinä.

## Lähteet ja tila

- [SDK:n Electron-ohje](https://node-llama-cpp.withcat.ai/guide/electron)
- [SDK:n getLlama-asetukset](https://node-llama-cpp.withcat.ai/api/functions/getLlama)
- [SDK:n binääritestin lähde](https://github.com/withcatai/node-llama-cpp/blob/master/src/bindings/utils/testBindingBinary.ts)
- Tarkka käytös tarkistetaan nykyisestä lukitusta 3.22.2-asennuksesta; master-haaraa ei pidetä lukittuna versiona.

## Mitattu osatulos

Koe tehtiin lukitulla Electron 45.2.1:llä (Node 24.22.1, libuv 1.52.1)
ja SDK:n CPU-paketilla 3.22.2. Riippuvuuskooste sisälsi 122 pakettia,
2 936 tiedostoa ja 82 422 034 tavua. Tämä luku koskee SDK-riippuvuuksia;
Electronin arkisto ja omat koeskriptit ovat erillisiä. Uusia asennuksia,
latauksia tai järjestelmätason oikeusmuutoksia ei tehty.

Lopullinen ESM-guardin sisältävä kierros:

| Tapaus | Toteutunut näyttö | Tulos |
| --- | --- | --- |
| Kontrolli, normaali | Importti, julkinen CPU-alustus/dispose, eri SDK-lapsen host-tarkistus, ready/loaded/done ja exit 0 | Läpäisi |
| Kontrolli, puuttuva binääri | Todellinen lapsi ja ready, latausvirhe, lapsen exit 1 ja parentin hallittu exit 17 | Läpäisi nimetyn virhekokeen |
| Kontrolli, owner-loss | Todellinen tarkistettu lapsi odotti ready-vaiheessa; owner suljettiin ja omat prosessit poistuivat | Läpäisi elinkaarikokeen |
| AppContainer, normaali | ESM-guard, importti, CPU-alustus ja dispose onnistuivat; helper-import valmistui; Node-fork ei palautunut | Hylätty: hostin child-deadline 258 |
| AppContainer, puuttuva binääri / owner-loss | Matriisi pysähtyi ennen näitä | Ajamattomat |

AC:n pääprosessin token, profiilin SID, capabilityt 0, integrity 4096,
täsmällinen Job ja sentinelin periytymättömyys tarkistettiin. AC:n SDK-lapsen
käynnistymisestä, tokenista, tiedostorajasta tai elinkaaresta ei syntynyt
näyttöä. Kontrollissa kaikki viisi tiedosto-operaatiota onnistuivat odotetusti;
se ei ole rajoitetun lapsen oikeustodiste.

Kaikkien neljän toteutuneen tapauksen prosessit poistuivat ja omat profiilit
sekä staged-puut siivottiin. Emergency-terminointia ei tarvittu. Kontrollin
owner-loss-tapauksen staged-poisto palautti ensin EBUSY-virheen; yhteisen
ajurin rajattu toinen yritys onnistui. Muiden kolmen poisto onnistui heti. Kokonaistulos on **passed=false ja exit 1**.
Aikaraja ei muuttunut hyväksytyksi SDK-yhteensopivuusluokaksi. Kolmen aiemman
diagnostiikkakierroksen alkuperäiset virheet ja siivousnäyttö säilyvät
paikallisina; samat kolme kontrollia onnistuivat ja AC pysähtyi myös niissä.
Viimeisimmät vaihehavainnot erottavat normaalin disposen, apurin importin ja
synkronisen fork-kutsun toisistaan.

Rajatut Node-testit: **34/34** (pakettikopiointi, raporttiprotokollan alkuperä,
virheluokittelu, oikeuspoikkeaman ja eheys-/instrumentointivirheen hylkäys).
Natiivihostin 11 tapauksen regressio säilytti aiemmat tiedosto-/Job- ja
elinkaaritulokset sekä avoimet AC-verkkotimeoutit ja LPAC-esteet; kaikki 11
siivousta onnistuivat. Electronin regressiossa kontrolli ja AC läpäisivät
3/3 kumpikin, LPAC pysähtyi kahdesti ennen JS:ää ja kaikki 8 siivousta
onnistuivat. Näiden kahden regression kokonaispoistuminen on edelleen exit 1,
ei täysi eristyksen hyväksyntä.

## Avoin fork-este ja seuraava portti

Havaittu fork-pysähtyminen sekä käytetty libuv 1.52.1 sopivat upstreamin
raportoimaan AppContainerin nimettyjen putkien uusintasilmukkaan.
[Node #66374](https://github.com/nodejs/node/issues/66374) kuvaa spawn/IPC-
pysähtymisen, ja [libuv #5181](https://github.com/libuv/libuv/pull/5181)
muuttaa AppContainer-putket LOCAL-nimiavaruuteen. Tämä on lähteiden tukema
syyhypoteesi; oman prosessin natiivipinoa tai korjatun runtime-version
vertailuajoa ei ole tehty. Pelkkä versionumeron nosto ei ole hyväksymisnäyttö.

#26 pysyy avoinna: SDK-lapsen oikeudet ja elinkaari AC:ssa on vielä
osoitettava. Seuraava rajattu työ on valita ja testata korjatun libuv-polun
sisältävä yhteensopiva runtime tai arvioida lapsen käynnistys erikseen.
Samat kontrolleihin verrattavat token-/Job-/IPC-/tiedosto- ja elinkaariportit
säilyvät. Verkko-, LPAC-, GGUF-/CUDA- ja koko sovelluksen portteja ei ohiteta.
