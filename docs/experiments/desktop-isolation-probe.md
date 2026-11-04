# Electronin GUI-pääprosessin eristyskoe

T09 / #10:n integraation ensimmäinen portti. Tavallinen GUI-kontrolli
on todennettu. AC-pääprosessin käynnistys epäonnistuu; koko GUI-eristystä
ei ole hyväksytty. Aiempi Electron Node -koe ajoi Node-tilaa,
eikä osoita BrowserWindowin tai Chromiumin lasten toimintaa eristyksessä.

## Rajaus

Kiinteä run-desktop-candidate-koeverbi käynnistää olemassa olevan lukitun
Electronin erillisestä synteettisestä koepaketista. Ensimmäinen pari on
rajoittamaton kontrolli ja AC ilman capabilityjä. Vain window-once sallitaan.
Koe ei lataa kielimallia, tee tarkoituksellisia verkkokutsuja tai käytä
CUDAa. Ohjelmallinen piirto säilyttää Chromiumin normaalit suojausasetukset;
Chromiumin mahdollinen GPU-apuprosessi ei ole paikallismallin GPU-koe.

Valmistelu ja Job käyttävät yhtä suoritinta ja BelowNormal-prioriteettia.
Jobissa on enintään 16 prosessia ja 6 GiB commit-raja. Hostin aikaraja on
30 sekuntia ja JavaScriptin 20 sekuntia. Rajat luetaan takaisin ennen
pääprosessin Resumea. Raja ei takaa koneen lämpötilaa tai VRAM-rajaa.

## Ohjelmaresurssit ja todentaminen

Vain kopioidun package-puun ohjelmaresursseille annetaan lisäksi
ALL APPLICATION PACKAGES -ryhmän luku/suoritus. Scratch ja private eivät
saa lisäoikeutta. Alkuperäisen Electron-asennuksen, projektin tai
käyttäjädatahakemistojen oikeuksia ei muuteta. Peruste on Electronin
[PR #54382](https://releases.electronjs.org/pr/54382): yksittäinen
AppContainer-SID paketissa voi estää Chromiumin restricted-token-lapsen
lukuoikeuden. ARAP-ryhmää ei lisätä tämän lisäksi. Tämä resurssiratkaisu
ei osoita koko Electron-mainin AC-yhteensopivuutta; se selvitetään kokeella.

Native host tarkistaa mainin tokenin, Jobin, resurssirajat ja yksityisen
koekahvan periytymättömyyden. Syntyneiden Job-lasten kuvat, tokenit ja
Job-jäsenyydet luetaan erikseen. Main raportoi app-metriikan prosessityypit,
jotka yhdistetään hostin havaintoihin. Rendererissä vaaditaan oikea
preload–IPC-valmiuskierros ja sivuteksti, sandbox, contextIsolation,
webSecurity sekä Node-integraation poissaolo. Suojauksia ei poisteta
yhteensopivuuskorjauksena.

Kontrollissa package/scratch/private-operaatiot onnistuvat. AC:ssa
package-luku ja scratch-kirjoitus sallitaan; private-luku/kirjoitus ja
kooditiedoston kirjoitus edellyttävät todellista käyttöoikeusestoa.
Raakanäyttö erottaa workerin viestit natiivihostin kuiteista. Kaikkien
omien havaittujen prosessien ja koekonsolin pitää poistua ennen
korjaavaa siivousta. Profiilin ja koepuun poisto varmennetaan.

## Jatkoportit ja näyttörajat

Käynnistyksen onnistuessa lisätään virhe- ja omistajan sulkukoe samaan
koepakettiin. Sen jälkeen siirrytään sovelluksen todellisen mainin,
backendin, malliprosessin ja MCP:n rajattuun viestintään sekä elinkaareen.
Säätyöntekijän FMI-kohderajaus suunnitellaan ja todennetaan erikseen:
pelkkä internetClient-capability tai ohjelman URL-tarkistus ei hyväksy sitä.

Koko #10 edellyttää samaan minimaaliseen sovelluspakettiin sidotut
verkko-/tiedostorajat sekä CPU/GPU-, virhe-, peruutus- ja sulkunäytöt.
Mainin jättäminen rajoittamattomaksi ei ole nykyisten ehtojen hyväksyntä.
Jaettu koekonsoli ja oma korjattu Node-haara eivät tämän kokeen perusteella
muutu tuotantoratkaisuksi. Raakadata säilyy ohitetussa .artifacts/-puussa.

## Varhaisen käynnistysvirheen diagnoosi

Erillinen `run-desktop-debug` / `-DebugStartup` käyttää samaa suljettua
kontrolli–AC-paria ja omaa juuri luotua main-prosessia. Windowsin
`DEBUG_ONLY_THIS_PROCESS`-tila ei ulotu Chromiumin lapsiin.
Tapahtumia on enintään 4096, poikkeuksia 128, debug-tekstejä 32 ja
luettua debug-tekstiä yhteensä enintään 64 KiB, 4 KiB per viesti.
Teksti säilyy yksityisenä base64-aineistona, ei suoritettavina viesteinä.

Ensimmäinen first-chance-breakpoint alkuperäisessä main-säikeessä voidaan
luokitella loader-candidateksi vain varmennetussa system32/ntdll.dll:n
MEM_IMAGE-alueessa. Tämä on rajattu heuristiikka, ei symboliratkaisu.
Muut poikkeukset jätetään käsittelemättömiksi. Sulku jatkaa myös
EXIT_PROCESS-tapahtuman; virhepolku lopettaa Jobin ja pumppaa tapahtumia
rajatusti ilman täyttynyttä tekstibudjettia. Debuggeria ei irroteta.

Debug-ajon `passed` on aina false. `diagnosticCollectionComplete` kertoo
vain keruun ja siivouksen valmistumisesta. Tavallinen GUI-hyväksyjä
hylkää debugger-rivit. Kontrollin ja AC:n loader-kandidaatin RVA:ta
verrataan erikseen, eikä eri tai puuttuva sijainti vahvista selitystä.
Debug-ajossa mahdollisesti onnistuva käynnistys ei korvaa tavallista ajoa.

## Mitattu osatulos

Tavallinen kontrolli käynnisti todellisen BrowserWindowin ja preload–IPC:n.
Main sekä kolme Chromium-apuprosessia tarkistettiin erikseen, ja Jobin
kokonaisprosessimäärä vastasi havaittua määrää. Sivun Node-rajapinnat
puuttuivat, rendererin sandbox, contextIsolation ja webSecurity olivat päällä.
Kontrollin viisi tiedosto-operaatiota onnistuivat ja omat prosessit poistuivat.

AC ilman capabilityjä pysähtyi ennen JavaScriptiä koodiin `0x80000003`.
Rajattu lokitusuusinta toisti virheen; AC:n lokitiedostoa ei syntynyt.
Se ei osoita virheen puuttumista. Profiilien, prosessien, konsolin ja
kopioitujen koepakettien siivoukset onnistuivat molemmissa tapauksissa.

Erillisen debug-parin keruu valmistui. Kontrolli päättyi normaalisti,
AC samaan natiiviseen poikkeukseen. Molempien loader-kandidaatti löytyi
samasta ntdll-moduulin suhteellisesta osoitteesta. AC:n seuraava breakpoint
oli Electronissa; ensimmäinen ja toinen poikkeusilmoitus jatkettiin
käsittelemättöminä. Debug-tekstiä ei tullut. Molempien `passed` pysyy falseksi
merkittynä, koska tämä pari on diagnoosia.

Lukevassa binäärivertailussa poikkeuspaikka seuraa `no-sandbox`-valinnan
etsintää ja kolmannen broker-vtable-metodin palautusarvon nollatarkistusta.
Saman Chromium-version [alustuskoodi](https://github.com/chromium/chromium/blob/156.0.8078.75/sandbox/policy/sandbox.cc#L46)
ja [BrokerServices-rajapinta](https://github.com/chromium/chromium/blob/156.0.8078.75/sandbox/win/src/sandbox.h#L48)
yhdistävät tämän `CreateAlternateDesktop`-kutsun onnistumistarkistukseen.
Tämä on ajo-osoitteen ja binäärin sekä lähteen vastaavuuteen perustuva
paikannus, ei symboloitu pinolista. Kutsun sisäistä Win32-virhettä tai
estävää yksittäistä resurssia ei vielä ole mitattu.

Ensimmäiset epäonnistuneet keruut säilyvät paikallisesti: Electronin
CR-erotin ei ollut JSON-rivi, ja debug-kontrollin alkuperäinen
16 poikkeuksen raja täyttyi normaaleista säieilmoituksista. Korjaukset
säilyttävät erotinrivit erottimina ja nostavat vain diagnostiikan rajan
128:aan; ne eivät muuta eristysoikeuksia tai hyväksy AC-käynnistystä.
685 kevyttä testiä sekä 58 GUI-/debug-, 25 inferenssi- ja 18 mallilatausverbin
virheellisen kutsun hylkäystä läpäisivät. Suojauksia ei poistettu,
kielimallia tai CUDAa ei käynnistetty eikä järjestelmäasetuksia muutettu.

Jatkoratkaisu on avoin: mahdollinen luotettu Electron-broker ja erikseen
valvottu verkkoesto on kuvattava oikeusmatriisin muutoksena. Pelkkä
verkkosääntö ei rajaa pääprosessin tiedosto-oikeuksia. Nykyistä sovellusta
ei muutettu, eikä #10:n kolmea alkuperäistä ehtoa ole vielä hyväksytty.
