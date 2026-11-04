# SDK:n ja binäärikoelapsen eristyskoe

T09c / #26 jatkaa [Electron Node -kokeen](electron-isolation-probe.md)
AppContainer-polusta. SDK:n importti, julkinen CPU-alustus ja erillinen
instrumentoitu binäärilapsikoe ovat eri näyttöjä. GGUF-painoja, generointia,
CUDAa, käyttäjäaineistoa tai sääverkkoa ei käytetä. #24:n synteettinen natiivinäyttö on valmistunut erikseen.
SDK:n oma LPAC-yhteensopivuus käsitellään jäljempänä T09d-kokeessa.

Korjattu erillinen Node 24.22.2 läpäisi myöhemmässä
[runtimevertailussa](runtime-comparison.md#mitattu-node-sdk-vertailu) kaikki
kuusi SDK-tapausta. Alla oleva alkuperäinen Electron-tulos säilyy kielteisenä;
sovelluksen runtime-valintaa ei muutettu.

## Paketti ja toistaminen

Projektijuuresta Windows PowerShellissä:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\e2e\isolation\run.ps1 -Probe sdk
```

Koe käyttää olemassa olevaa lukittua Electron-arkistoa ja node-llama-cpp
3.22.2:n paikallista asennusta sekä @node-llama-cpp/win-x64 3.22.2:ta.
Koeajon aikana mitään ei asenneta tai ladata. Node-vertailun työkalujen
hankinta ja käännös ovat erillinen [valmisteluvaihe](runtime-comparison.md).
build=never ja skipDownload=true asetetaan
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

Electron-polulla ennen SDK-importtia guard vaatii ESM-resoluutioksi täsmälleen
`electron:electron`. Node-polulla vaaditaan erillinen kiinteä prosessikuva, versio ja tarkiste.
Electronin guard tarkistaa nykyisen apurin käyttämän ESM-polun, jotta
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
kirjoittamassa stdin-putkessa. Tästä kuittausputkesta workerille periytyy vain lukupää.
Node-vertailun jaettu oma koekonsoli ja sen poistuminen kuvataan
[vertailusopimuksessa](runtime-comparison.md); putkien kahvalista ei yksin
kuvaa kaikkia kommunikaatiopintoja.
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

## Alkuperäinen Electron-osatulos

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

## Fork-esteen jatkoselvitys ja seuraava portti

Alkuperäinen fork-pysähtyminen sekä libuv 1.52.1 sopivat upstreamin
raportoimaan AppContainerin nimettyjen putkien uusintasilmukkaan.
[Node #66374](https://github.com/nodejs/node/issues/66374) ja
[libuv #5181](https://github.com/libuv/libuv/pull/5181) ohjasivat
[rajattuun runtimevertailuun](runtime-comparison.md#mitattu-node-sdk-vertailu).

Saman lähteen muuttamaton Node toisti aikarajan. Vain upstreamin pipe.c-
korjauksen sisältävä paikallinen Node läpäisi SDK-matriisin 6/6 tapausta:
todellinen AC-lapsi, hostin oikeustarkistus, viisi tiedostokoetta, alkuperäinen
helper-protokolla sekä normaali-, virhe- ja owner-loss-siivous. Menetelmän,
lähdevertailun nimipoikkeaman ja tulosten omistaja on runtimevertailu.

Tämä täyttää #26:n rajatun Node-/CPU-helper-polun näyttötarpeen. Electronin
sisäinen runtime säilyy alkuperäisessä tilassaan. Tuotannon runtime-valinta,
verkko, LPAC, GGUF/CUDA ja koko sovelluksen eristys ovat seuraavia erillisiä
portteja; SDK-osakoe ei hyväksy niitä.

## T09d: nimetty LPAC-SDK-koe

Issue #27 jatkaa parentia #10. Lähtökohtana ovat #24:n nimetty
LPAC + registryRead -natiivinäyttö ja #26:n korjattu erillinen Node.
Tämä koe ei vaihda sovelluksen Electron-runtimea tai toimita omaa Node-haaraa
käyttöversioon. Ei GGUF-painoja, generointia, CUDAa, verkkoa tai käyttäjätietoja.

Valinta tehdään ennen kokeen alkua:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\e2e\isolation\run.ps1 -Probe sdk-lpac -SdkRuntime local-patched -SkipBuild
```

`-SkipBuild` edellyttää tästä lähdeversiosta jo rakennettua natiivihostia.
Käytetään aiemmin valmistettua, tarkisteella varmennettua Nodea ja SDK 3.22.2:n
muuttamatonta CPU-binääriä. Uutta Nodea tai SDK:ta ei käännetä eikä hankita.
`build: never`, `skipDownload`, `gpu: false` säilyvät. Julkinen CPU-alustus
ja dispose tapahtuvat ennen erillistä instrumentoitua alkuperäistä helperiä.

Uusi testiverbi `run-sdk-node-candidate` hyväksyy vain t09d-koeprofiilin,
control/ac/lpac-tilat ja once/missing-binary/hold-elinkaaret. Kontrollin ja
AC:n capabilityjoukko on tyhjä; LPAC saa täsmälleen registryRead-SID:n
SE_GROUP_ENABLED-attribuutilla. Host tarkistaa tarkan joukon sekä keskeytetystä
SDK-parentista että todellisesta helperistä ennen latauksen jatkamista.
Alkuperäiset SDK-verbit eivät hyväksy LPAC:ia. Runtimevalinnan virhe tai
vieras `policyProbe` pysäyttää kokeen, eikä oletus vaihdu huomaamatta.

AAP-only-fixture on oma synteettinen tiedosto. Sen suojattu ACL korvaa
paketin yleisen ACL:n readOnlyTree-vaiheen jälkeen: ei paketin oman SID:n
lukuoikeutta. Sekä SDK-parentti että helper lukevat sen. Kontrollissa ja AC:ssa
luku onnistuu, LPAC:ssa vaaditaan EACCES/EPERM. Tämä käyttäytymisnäyttö erotetaan
pyydetystä LPAC-käynnistysasetuksesta ja tokenkyselystä. Mahdollinen null/87
ei muutu vahvistetuksi LPAC-tokenlipuksi. Helperin aiemmat viisi tiedostokoetta
säilyvät kuudentena lisätyn AAP-luvun rinnalla.

Matriisi on kolme profiilia × normaali, puuttuva binääri ja owner-loss.
Jatkoelinkaaret ajetaan vain saman profiilin normaalin läpäisyn jälkeen.
Sama valmistettu runtime-, SDK- ja binääriaineisto sekä host ovat käytössä.
Owner-loss tehdään hostin tarkistaman helperin odottaessa ready-vaiheessa.
Täsmällinen ajuri-, omistaja-/host-, SDK-parentti-, helper- ja konsoliprosessien
joukko tarkistetaan; omien lapsiprosessien on poistuttava ennen siivousapua.
Omistajan tarkoituksellinen tappaminen ei korvaa tätä poistumisnäyttöä.
Oikeus-, identiteetti-, instrumentointi- tai siivousvirhe pysäyttää matriisin.
Tarkasti nimetty toistettava SDK-yhteensopivuuseste säilyy kielteisenä tuloksena.

### Näytön rajat

T09d:n tulos on erillisen korjatun Noden SDK-yhteensopivuuskoe.
AAP-fixture ei yksin ole verkon, kaikkien tiedostojen tai rekisterin eristysnäyttö.
RegistryRead on laajempi oikeus kuin yksittäisten Winsock-avainten luku;
sen hyväksyttävyys tuotantoon jää erikseen arvioitavaksi.
Jaettu piilotettu koekonsoli säilyy erillisenä avoimena tuotantorajana.
#10:n ulkoisen verkon, FMI:n, todellisten mallipainojen, CPU/GPU-malliajon,
MCP:n ja koko sovelluspaketin hyväksymisehtoja ei kuitata tällä osakokeella.
Ajankohtainen tulos ja tokeniseuranta kirjataan issueen #27.

### T09d:n mitattu tulos

Nimetty matriisi läpäisi **9/9 tapausta**, koko ajurin exit 0.
Runtime oli aiemmin valmistettu paikallisesti korjattu Node 24.22.2,
SDK ja CPU-binääri 3.22.2. Kaikissa tapauksissa käytettiin samaa
valmistettua runtime-/riippuvuusaineistoa ja hostia. Lähde- ja binääritarkisteet
jäädytettiin ennen ajoa. Asennuksia tai uusia runtime-käännöksiä ei tehty.

| Profiili | SDK-parentin ja helperin capabilityt | AAP-luku molemmissa | Elinkaaret |
| --- | --- | --- | --- |
| Tavallinen kontrolli | Tyhjä joukko, Medium IL | Onnistui | Normaali, puuttuva binääri ja owner-loss läpäisivät |
| AppContainer | Tyhjä joukko, Low IL | Onnistui | Kaikki kolme läpäisivät |
| Nimetty LPAC + registryRead | Vain täsmällinen registryRead-SID, enabled, Low IL | Estyi käyttöoikeusvirheeseen | Kaikki kolme läpäisivät |

Kaikissa yhdeksässä tapauksessa julkinen CPU-alustus ja dispose valmistuivat
ennen instrumentoituun helperiin siirtymistä. Normaaleissa kolmessa tapauksessa
alkuperäinen apuri tuotti ready/loaded/done ja poistui onnistuneesti.
Puuttuvan binäärin kolmessa tapauksessa helper päättyi exit 1:een ja
SDK-parentti hallitusti exit 17:ään. Kolme owner-loss-tapausta tehtiin
hostin tarkistaman oikean helperin odottaessa ready-vaiheessa.

Paketin luku ja scratch-kirjoitus onnistuivat kaikissa helper-prosesseissa.
AC- ja LPAC-helpereissä private-luvun/kirjoituksen sekä moduulitiedoston
muuttamisen piti estyä, ja ne estyivät. Kontrollissa ne onnistuivat.
Erillinen AAP-tiedosto erotti lisäksi AC:n ja LPAC:n sekä SDK-parentissa
että helperissä. LPAC-lisäkysely palautti rajoitetuissa prosesseissa
edelleen null/87; toteutunut AAP-käyttäytyminen ei muuta kyselyn tulosta.

Kaikkien yhdeksän tapauksen tarkat omat prosessijoukot, mukaan lukien
konsolit, poistuivat ennen siivousapua. Omat profiilit ja staged-puut
poistettiin; hätäterminointeja ei tarvittu. Yksityinen tarkistekoonti
kattaa yhdeksän raakatulosta, matriisiyhteenvedon ja riippuvuusmanifestin.
Aikaisempia #24:n ja #26:n tuloksia ei kirjoitettu uudelleen.

Paikallisen eristystestirungon **524 testiä** läpäisi.
Todellinen uusi host hylkäsi 22 uutta kiellettyä SDK-yhdistelmää ja
23 vanhempien koeverbien kiellettyä yhdistelmää ennen profiilinluontia.
Natiivin hostin käännös valmistui varoitukset virheiksi käsittelevillä
asetuksilla. Nämä ovat tämän nimetyn testijoukon tuloksia; sovelluksen
E2E- tai malliajoja ei tehty. Riippumaton katselmus ja julkaisun tila
raportoidaan issueen #27.

Tulos avaa seuraavan rajatun GGUF-/mallilatauskokeen suunnittelun.
Se ei valitse omaa Node-haaraa sovelluksen toimitusruntimeksi eikä täytä
parentin #10 kaikkia hyväksymisehtoja.
