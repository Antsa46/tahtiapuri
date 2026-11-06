# MCP-työntekijän kaksikanavainen kuljetus

Tämä dokumentti omistaa eristettyyn Node-prosessiin vietävän MCP-työntekijän
viestimuodon ja stream-koosteen. Toteutettu työntekijä on erillinen ehdokas;
nykyinen `startMcp`-oletusentry ei vaihdu. Natiivi Windows-käynnistäjä,
resurssipaketin oikeudet, mainin todentamisen koko käynnistysketju ja
käyttöjärjestelmätason näyttö ovat vielä jatkotyötä. Todentamisen rajatut
perusosat kuvataan alla; niitä ei vielä ole kytketty oletuskäynnistykseen. Koko tavoitteen omistaa
[backendin ja MCP:n eristyspolku](backend-mcp-isolation.md).

## Vastuut

- Luotettu tuleva natiivibroker omistaa MCP-isännän stdion sekä sovelluksen
  autentikoidun kehityskanavan. Se ei anna yhteyskuvausta, tokenia,
  backendin datajuurta tai mallipainoja työntekijälle.
- `native-worker-entry.ts` on kiinteä Node-entry ilman omia argumentteja.
  Se käynnistää `startMcpMuxWorker`-koosteen stdion yli. Node-version,
  ympäristön ja ohjelmapaketin määrää tuleva luotettu käynnistäjä.
- `mcp-mux-worker.ts` muodostaa MCP- ja kehityskanavan, käyttää oikeaa
  `startMcpStreams`-palvelinta ja omistaa molempien kanavien sulun.
- `mcp-mux-wire.ts` tarkistaa binääriotsakkeen, suunnan, koon ja järjestyksen.
- `mcp-mux-channel.ts` sovittaa vain kaksi kiinteää kanavaa Node-streameiksi.
  Se rajaa myös Node-streameihin jonoutuvat kirjoitukset ja lukematta
  jäävät tavut; pelkkään `highWaterMark`-arvoon ei nojata.
- `mcp-mux-writer.ts` omistaa yhteisen fyysisen kirjoitusjonon, vastapaineen
  ja määräajat. Virtuaalikanavan kirjoituscallback valmistuu vasta fyysisen
  callbackin sekä tarvittavan drainin jälkeen.

MCP:n sisäisen pyyntöjonon, työkalujen ja protokollaperuutuksen sopimus on
[stream-koostamisen ohjeessa](../experiments/mcp-stream-composition.md).
Ulompi kuljetus ei korvaa sitä eikä väitä yksin rajaavansa koko prosessin muistia.

## TMCP/1-kehys

Otsake on täsmälleen 16 tavua. Kokonaisluvut ovat little endian -muodossa.
Taulukon offset lasketaan nollasta.

| Offset | Pituus | Merkitys |
| --- | ---: | --- |
| 0 | 4 | Täsmälliset ASCII-tavut `TMCP`; yläbittisiä vastineita ei hyväksytä |
| 4 | 1 | Versio 1 |
| 5 | 1 | Laji |
| 6 | 2 | Varattu, molempien tavujen on oltava nolla |
| 8 | 4 | Payloadin tavumäärä |
| 12 | 4 | Suuntakohtainen unsigned 32-bit järjestysnumero |

Kumpikin suunta alkaa numerosta 1. Seuraava arvo on edellinen + 1
modulo 2^32: maksimiarvon jälkeen tulee 0. Väärä järjestys sulkee istunnon.
Kehys ei ole käyttöoikeustodiste; tuleva broker todentaa prosessin ja
kahvat erikseen. Yhteys ei ole yleinen TCP- tai tiedostorajapinta.

| Laji | Broker → työntekijä | Työntekijä → broker |
| --- | --- | --- |
| 1: MCP_DATA | 1 tavu – 16 KiB | 1 tavu – 256 KiB |
| 2: DEV_DATA | 1 tavu – 64 KiB | 1 tavu – 16 KiB |
| 3: CLOSE | Tyhjä payload | Kielletty |
| 4: READY | Kielletty | Tyhjä payload, kerran ennen dataa |

DATA sisältää stream-tavuja. JSON-rivi saa jakaantua useaan kehykseen;
kehysten rajat eivät ole sovellusviestien rajoja. Ennen payloadin varaamista
otsake tarkistetaan kokonaan. Osittaiset tavut kopioidaan rajattuun omaan
puskuriin; suuren ulkoisen Bufferin taustamuistia ei säilytetä viipalena.
Osittaisen kehyksen enimmäiselinaika on kaksi sekuntia ensimmäisestä
vastaanotetusta tavusta. Yksittäiset lisätavut eivät aloita aikaa uudelleen.

## Puskurit ja vastapaine

Yhteinen fyysinen FIFO sisältää enintään 16 kirjoitusta ja 512 KiB varattuja
tavuja. Otsakkeet ja fyysisen Writablen jo puskuroimat tavut lasketaan mukaan.
Kunkin kirjoituksen määräaika on kaksi sekuntia jonoon hyväksymisestä.
Virtuaalikanavan omat kirjoitukset rajataan ennen Noden sisäiseen jonoon
lisäämistä samoihin lukumäärä- ja tavurajoihin; yksittäinen kirjoitus
noudattaa kyseisen suunnan payload-rajaa.

MCP:n lukematta jäävän binäärikanavan raja on 16 KiB. Kehityskanavan raja
on 64 KiB sekä UTF-8-tekstimuodossa enintään kolmen tavun keskeneräinen
merkkijono dekooderin sisällä. Tekstiksi dekoodatut puskuriyksiköt lasketaan
konservatiivisesti neljän tavun kokoisina. Tämä decoder-lisätila ei suurenna
ulomman kehyksen payload-rajaa.

Molemmat kanavat jakavat yhden fyysisen FIFO:n: hidas lukija voi viivästyttää
myös toista kanavaa. Ruuhka tai aikaraja sulkee koko istunnon. Ensimmäisessä
versiossa ei ole erillistä kreditointi- tai priorisointiprotokollaa. Tulevan
brokerin on toteutettava omat vastaavat rajansa; työntekijän rajat eivät
rajaa brokerin muistia tai isännän syötettä.

## Käynnistys ja sulku

Kanavat ja virhekäsittelijät asennetaan ennen READY-kirjoitusta. Vastapuoli
voi vastata READY-tavuihin ennen sen kirjoituscallbackia, joten vastaanotto
on tuolloin jo valmis. READY osoittaa vain protokollan alun, ei OS-eristystä.

CLOSE pysäyttää molempien kanavien sisäänoton ja sulkee sisäisen MCP-istunnon.
Vain jo fyysiseen jonoon hyväksytyt kirjoitukset saavat valmistua alkuperäisten
määräaikojensa puitteissa. Pelkästään virtuaalikanavaan jonoutuneet kirjoitukset
perutaan, ja jokainen callback valmistuu enintään kerran. Lopuksi tuloste
suljetaan. CLOSEn jälkeinen odotettu EOF ei muuta normaalia sulkua virheeksi.
Myöhäistä dataa ei enää käsitellä.

Tuleva broker ei saa suorittaa kehityspyyntöjä enää omassa sulkutilassaan,
vaikka se lukisi loppuun työntekijän jo aloittamia kehystavuja. Sulku ei lupaa
viimeistä MCP-vastausta kesken olevalle pyynnölle.

EOF ennen CLOSEa, virheellinen tai katkennut kehys, rajanylitys sekä
fyysisen kanavan virhe päättävät istunnon epäonnistuneena. Osittaisen
kirjoituksen perään ei yritetä lisätä kuittausta. Erillistä CLOSED-kehystä
ei ole. Tulosteen lopetuscallbackin virhe ja synkroninen poikkeus eivät saa
muuttua onnistuneeksi lopputilaksi.

Kooste raportoi protokollatuloksen `closed` tai `failed`. Kiinteä entry
asettaa sen perusteella prosessin poistumiskoodiksi 0 tai 1. Varsinainen
prosessin poistuminen, Jobin tyhjeneminen ja oikeuksien siivous kuuluvat
tulevan natiivibrokerin riippumattomaan tarkistukseen.

## Näyttö ja jatkorajat

Paikalliset testit käyttävät oikeaa MCP SDK:ta ja synteettistä kehitysvastaajaa.
Ne kattavat molemmat kanavat, fragmentoinnin, protokollavaihdon, jatkuvat
pyynnöt, rajanylitykset, hitaat kirjoitukset, kesken työn sulun, virheellisen
lopetuksen sekä UTF-8-dekooderin rajatun lisätilan.

Erillinen Windowsin Node-prosessi on suorittanut alustuksen, työkalulistauksen
ja tilakyselyn todellisten stdin/stdout-putkien yli sekä poistunut omistajan
CLOSE-pyynnöstä koodilla 0 ilman pakkosulkua tai stderr-tulostetta.
Koetestin odottamattoman päättymisen ja pakkosulun odotus on rajattu;
todentamaton poistuminen ilmoitetaan virheenä.

Yhden ESM-tiedoston paketointikelpoisuutta on kokeiltu nykyisen työkaluketjun
Rolldownilla. Kootun työntekijän vastaava prosessikoe onnistui, kun testin
latauskoukku salli vain entryn ja Noden sisäänrakennetut moduulit eikä antanut
repositoryn pakettien paikata puuttuvia importteja. Ensimmäinen yritys
pysähtyi testikäynnistimen Windows-polun muotoon; `--import` tarvitsee tässä
file-URL:n. Epäonnistunut raportti säilyy erillisenä. Tämä on alustava
paketointikoe: toimitettavan paketin tarkisteet, alkuperä, lisenssit ja
suljettu tiedostoluettelo toteutetaan alla kuvatussa erillisessä rakennuksessa.

Kooste, tavallinen Node-prosessi ja latauskoukku eivät toteuta AppContaineria,
LPAC:ia, tiedostojen OS-rajaa tai verkkokieltoa. Mainin autentikointia,
kehityskytkimen koko natiiviketjua, todellista mallia tai FMI-yhteyttä ei
ole tämän osavaiheen perusteella hyväksytty.

Myös vanhan `server.ts`-entryn modernista tunnistuksesta vanhempaan
alustukseen siirtymisen omistajuus jää erilliseksi regressio-/siirtotyöksi.
Ehdokkaan korjausta ei esitetä vanhan oletusentryn korjauksena.

## Kiinteä MCP-ajopaketti

`scripts/native/build-mcp-runtime.ps1` rakentaa erillisen paikallisen paketin.
Se ei vaihda sovelluksen oletusentryä, käynnistä työntekijää eikä myönnä
Windows-oikeuksia. Rakennus käyttää jo asennettua Rolldown 1.2.16:ta;
uutta riippuvuutta tai verkosta tehtävää asennusta ei lisätä.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\native\build-mcp-runtime.ps1
```

Uusi rakennusjuuri syntyy `.artifacts/native/mcp-runtime/builds/`-puuhun
suojattuna vain omistavalle käyttäjälle ja SYSTEMille. Rakennus on sarjallinen,
matalalla prioriteetilla ja rajatulla suoritinkuormalla; yksittäisellä
rakentajaprosessilla on kahden minuutin määräaika. Epäonnistuneen rakennuksen
lokit ja mahdollinen hylätty kooste säilyvät. Juuri ei kelpaa uudelleen
valmisteluun, eikä aiempaa pakettia ylikirjoiteta.

Paketissa on täsmälleen seuraava sisältö:

```text
package/
  node.exe
  mcp-worker.mjs
  package.json
  runtime-manifest.json
  licenses/
    node-LICENSE.txt
    mcp-server-LICENSE.txt
    mcp-core-LICENSE.txt
    zod-LICENSE.txt
```

Virallisen Node 24.22.2 -arkiston, suoritettavan tiedoston ja arkistoon
verratun lisenssin tarkisteet ovat kiinteät. Yhden ESM-työntekijän lähteet
ovat rajattu MCP-moduulin ja validation-moduulin TypeScript-joukko sekä
MCP server/core 2.4.0 ja Zod 4.6.7. Paikalliset importit ratkaistaan suoraan
lähteisiin: `dist` tai yleinen `node_modules`-haku ei ole varareitti.
TypeScript-asetusten automaattinen etsintä on pois käytöstä.

Koostajalle annettavat todelliset lähdetavut tarkistetaan ennen rakennusta
ja sen jälkeen. Paikallinen `runtime-inputs.json` tallentaa myös lockfilen,
pakettimetatiedot, rakentajan reseptin, Rolldownin suoritettavat JS-tiedostot,
sen pluginutils-riippuvuuden ja käytetyn natiivikirjaston tarkisteet.
Natiivikirjaston valinta sidotaan tarkistettuun tiedostoon; perityt WASI-
valinnat eivät voi vaihtaa sitä. Tämä on luotetun kehitysympäristön
rakennuskuitti, ei suoja saman käyttäjän tai ylläpitäjän kaappaamaa
rakentajaa vastaan eikä kaikkien npm-julkaisujen riippumaton alkuperäauditointi.

Lopullinen tuloste saa olla vain yksi ESM-tiedosto ilman lisäresursseja tai
sourcemapia. Sen parsitusta koodista hyväksytään vain `node:stream`,
`node:process` ja `node:crypto`; dynaamiset importit ja suorat require-kutsut
hylätään. Koostajan metatiedoissa havaittu, lopullisesta koodista poistunut
`node:module`-apu erotetaan todella toimitetuista importeista. Alkuperäiset
hylätyt rakennukset säilyvät näytössä. Tämä tarkistus ei väitä estävänsä
kaikkea dynaamista koodin suoritusta tai korvaavansa OS-eristystä.

Manifesti sitoo kiinteän tiedostojoukon, pituudet ja SHA-256:t. Erillinen
`mcp-runtime-pins.h` sitoo myös manifestin tarkisteen tulevaa natiivibrokeria
varten. Paketin sisältä luettu, itseään vastaava manifesti ei yksin todenna
paketin alkuperää: tulevan luotetun käynnistäjän on verrattava sitä omaan
hyväksyttyyn tarkisteeseensa. Paketin linkit, ylimääräiset tiedostot ja
hakemistot sekä muuttuneet tavut hylätään. Backendin resurssiluetteloa,
tallennusjuurta tai mallipainoja ei oteta MCP:n pakettiin.

Rajattu näyttö: 12 paketti-/parseritestiä läpäisi. Oikean paketin omalla
Nodella ja koostetulla työntekijällä tehty prosessikoe sekä vertailuna
lähdekäännöksen prosessikoe läpäisivät, yhteensä 2/2 ilman ohituksia.
Alustus, työkalulista, synteettinen tilavastaus ja CLOSEsta poistuminen
koodilla 0 toimivat ilman pakkosulkua tai stderr-tulostetta. Testin erillinen
latauskoukku esti repositoryn riippuvuuksien käyttämisen; paketin tavut
varmennettiin ennen ajoa ja sen jälkeen. Koukku ei kuulu toimitettavaan
pakettiin. Natiivi välittäjä, mainin todentaminen, LPAC ja koko sovelluksen
verkko-/tiedosto-/elinkaarinäyttö ovat yhä seuraavia portteja.

## Mainin kertakäyttöinen pääsyoikeus ja natiivin vastapään tarkistus

`native-development-admission.ts` on Mainin omistama erillinen ehdokas.
Omistaja määrittää backendin istunnon ensin ja peruu sen sulussa tai virheessä.
Pääsyoikeuden myöntäjä ei julkaise tiedostoja, käynnistä prosesseja tai
osoita niiden poistumista. Nykyinen `DevelopmentHost` ei vielä käytä sitä.

Yksi käynnistyssukupolvi myöntää yhden kertakäyttöisen tunnuksen kerrallaan.
Tunnus on eri salaisuus kuin backendin istuntotunnus; vanha istuntotunnus
ei kelpaa vaihtoehtoiseksi autentikoinniksi. Tunnus kulutetaan ja asiakkaan
paikka varataan synkronisesti ennen backendin liittämistä. Tilat ovat
`idle → available → attaching → active → detaching → idle`; epävarma
liittäminen tai irrotus päättää sukupolven `disabled`-tilaan.

Uusi tunnus voidaan myöntää vasta alkuperäisen liittämisen ja sen jälkeisen
irrotuksen valmistuttua. Aikakatkaistu liittäminen yritetään edelleen
irrottaa sen oikeasti valmistuttua, mutta myöhäinen onnistuminen ei avaa
sukupolvea uudelleen. Vanhan asiakkaan myöhäinen vastaus tai aikakatkaisu
ei saa palautua eikä sulkea korvaavaa asiakasta. Sukupolven yhteisiä keskeneräisten kutsujen
varauksia on enintään neljä myös asiakkaan vaihtuessa. Varaus vapautuu
vastauksesta, virheestä tai kolmen sekunnin oletusmääräajasta; vanhan
asiakkaan irrotus ei vapauta sen keskeneräisiä varauksia. Aikakatkaisu
ei yksin todista taustalla olevan backend-pyynnön poistumista. Kuljetuksen tavurajat,
kutsutahti ja tunnisteiden uudelleenkäytön esto kuuluvat tulevalle isännälle.

Main todentaa tässä suunnitelmassa yksityisen käynnistystunnuksen hallinnan.
Tämä ei ole vastavuoroinen OS-todistus brokerin binääristä tai sen työntekijän
eristyksestä. Sovelluksen luotettu käynnistäjä ja saman käyttäjän tavallinen
hallintaympäristö pysyvät luottamusrajan sisällä.

`native-development-bootstrap.ts` ja `main-bootstrap.h` määrittelevät saman
kiinteän 96 tavun kuvauksen: `TMBOOT1` ja nollatavu, versio ja koko,
Mainin PID, nollattu varattu kenttä, tarkka 64-bittinen Windows FILETIME,
16 tavun putkinonce, 16 tavun sukupolvi ja 32 tavun käynnistystunnus.
Kuvauksessa ei ole vapaata tiedostopolkua, ohjelmaa tai argumentteja.
FILETIME hankitaan prosessikahvasta, ei JS:n kellosta tai pyöristetystä
käynnistysajasta. Tarkan Main-tunnisteen erillinen natiiviapu on toteutettu alla; sen
kytkentä koko käynnistysketjuun on vielä liittämistyötä.

`main-peer.h` avaa vain nonceen perustuvan paikallisen putken. Se tarkistaa
avatun putken palvelin-PID:n, säilyttää sitä vastaavan elävän prosessikahvan
ja vertaa tarkkaa käynnistysaikaa ennen kanavan luovuttamista. Tarkistuksen
virhe estää käytön. Kahvat eivät periydy, ja putki avataan identification-
tasolla ilman brokerin impersonointioikeutta. Rakentaja ei lähetä tavuja.
Tarkistus suojaa vanhentuneelta tai väärälle palvelinprosessille osoittavalta
kuvaukselta; se ei yksin validoi kuvaustiedoston omistajaa tai oikeuksia.

Rajattu Windows-koe rakentuu komennolla:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\integration\mcp\run-native-main-peer.ps1
```

Koe käyttää synteettistä aineistoa ja oikeaa Windows-putkea. Se varmentaa
TypeScriptin kanssa yhteisen binäärifixturen, oikean vastapään, väärän PID:n,
vanhentuneen käynnistysajan ja puuttuvan putken hylkäämisen sekä sen, ettei
hylätylle vastapäälle lähetetä salaisuutta. Malleja tai eristysprofiileja ei
käynnistetä eikä Windowsin oikeusasetuksia muuteta. Käännös on sarjallinen,
matalalla prioriteetilla ja yhdellä suorittimella. Käännöksen aikakatkaisussa
tehdään rajattu oman prosessipuun sulkuyritys; tämä ei ole Job-eristys eikä
riippumaton jälkeläisten poistumisen todiste. Epävarmuus tuottaa virheen,
yksityisen siivousraportin ja estää onnistumiskuitin.

Yksikkötestit kattavat kertakäyttöisyyden, rinnakkaiset lunastukset, hitaat
liittämiset ja irrotukset, peruutuksen sekä vanhan asiakkaan myöhäiset
virheet. Integraatiotestit käyttävät oikeaa `DevelopmentService`- ja
`AssistantService`-logiikkaa: kumpikaan UI/MCP-rooli ei näe eikä peru toisen
töitä, MCP:n irrotus vapauttaa vain sen työt ja jonossa oleva UI-työ jatkuu.
Mallivastaukset ovat synteettisiä.

Ennen varsinaista käyttöönottoa puuttuvat edelleen suojatun kuvaustiedoston
julkaisu sekä alla toteutettujen lukijan ja Main-tunnisteavun liittäminen,
autentikointikuittaus ja sen aikarajat, brokerin hallinta- ja työntekijädatan
erottelu, legacy/native-omistajuuden yhteensovitus sekä työntekijän käynnistys,
Jobin tyhjeneminen ja oikeuksien siivous. Yksikään tämän osan testi ei
hyväksy verkkokieltoa tai koko MCP:n OS-eristystä.

Windows-rajapintojen lähteet:
[GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes),
[GetNamedPipeServerProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeserverprocessid) ja
[CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew).

## Kuvaustiedoston lukija ja Mainin tarkka tunnisteapu

`bootstrap-file.h` lukee vain kiinteän `main-bootstrap.bin`-tiedoston.
Se ei luo tai korjaa käyttöoikeuksia. Polun täytyy olla paikallisen kiinteän
levyn kanoninen absoluuttinen polku. Verkko-, laite-, vaihtoehtoisen datavirran
ja ylähakemiston kautta kulkevat polut hylätään. Avatut hakemistokahvat
säilyvät koko lukemisen ajan ilman poiston jakamista; reparse-kohteet ja
lopullisesta polusta poikkeavat kahvat hylätään. Saman käyttäjän tai
järjestelmänvalvojan tekemää haitallista ACL-muutosta ei väitetä estetyksi.

Kontrollihakemiston omistajan täytyy olla kutsuvan käyttäjän SID.
Suojatussa pääsylistassa sallitaan täsmälleen käyttäjän ja SYSTEMin
kaksi täyden oikeuden ACEä hakemisto- ja tiedostoperinnällä. Tiedoston
omistaja tarkistetaan erikseen; sen suojaamattomassa pääsylistassa on vain
samat kaksi tehokasta perittyä ACEä. Puuttuva tai null-pääsylista, ylimääräinen
osapuoli, muu oikeusmaski tai perintämuoto hylätään. Arvot luetaan
`GetSecurityInfo`-kutsulla avatusta kahvasta, ei erillisen polkuhavainnon
perusteella. Pelkkä sopiva ACL ei osoita omistajaa.

Tiedoston pitää olla tavallinen levytiedosto, jolla on yksi linkki ja
96 tavun koko. Lukukahva estää tavallisen kirjoitus- ja poisto-oikeudella
avaamisen. Tavut kopioidaan kerralla omaan kiinteään puskuriin; kahvat,
polut ja oikeudet tarkistetaan uudelleen. Lukija palauttaa vain puretun
arvon ja vapauttaa lukukahvat ennen autentikointia. Näin Main voi kuluttaa
ja poistaa kuvauksen ennen kuittausta. Eri kenttiä ei lueta eri avauksista.

`main-identity.cpp` hyväksyy vain `--identity`-toiminnon ja kanonisen
positiivisen PID-luvun. Se avaa ei-periytyvän kysely-/synkronointikahvan,
vaatii elävän prosessin ja palauttaa PID:n sekä FILETIMEn 16 merkin
heksadesimaalimerkkijonona. `native-main-identity.ts` kysyy vain oman
prosessinsa PID:n, tarkistaa vastauksen täsmällisen muodon ja käsittelee
ajan `bigint`-arvona. Lapselle annetaan rajattu ympäristö ja tulosteraja;
prosessin sulkeutuminen pitää havaita ennen tuloksen hyväksymistä.
Epävarma poistuminen palautuu erillisenä virheenä. Avun käyttäjän täytyy
vielä varmistaa apubinäärin runtime-paketti ennen käynnistystä.

Tämä kysely todistaa havainnon kyselyhetkellä. Broker tarkistaa edelleen
avaamansa putken todellisen palvelin-PID:n ja tarkan käynnistysajan sekä
säilyttää elävän Mainin prosessikahvan; kyselyapu ei korvaa sitä.

Erillinen Windows-testi rakentaa pienet apubinäärit ja käyttää ohjelman
oikeaa `securePrivateDirectory`-toimintoa synteettisissä fixtureissa:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\integration\mcp\run-native-bootstrap.ps1
```

Rajattu 22 tapauksen Windows-ajo läpäisi kokonaisuudessaan, myös loppusiivouksen.
Se kattaa oikean perityn ACL:n, ylimääräisen osapuolen ja puuttuvan SYSTEM-oikeuden,
null-pääsylistan, suojatun lehden, kovan linkin, välittömän ja välihakemiston
junction-linkin, koon/formaatin/tyypin virheet, kirjoittavan kahvan ristiriidan,
lukukahvan kirjoitus-/poistoeston sekä tiedoston vaihdon lukijan poistuttua.
Main-tunnisteapu verrattiin erilliseen .NETin FILETIME-havaintoon; virheelliset
argumentit hylättiin. Lisäksi 10 yksikkötestiä varmentaa tuloksen,
lapsiympäristön, sulun odotuksen ja epävarman poistumisen käsittelyn.
Erillistä väärän omistajan Windows-fixturea ei ole ajettu.

Ensimmäiset epäonnistuneet ajot säilyvät: liian syvä testin työskentelypolku,
testifixturen tarpeettoman laaja ACL-persistointi ja null-pääsylistan
poistaman perinnän aiheuttama loppusiivousvirhe. Korjaukset ovat testin
valmistelussa/palautuksessa; yhteistä tuotannon hakemistoapuria ei muutettu.
Yksittäisten testien onnistuminen epäonnistuneen loppusiivouksen yhteydessä
ei kelpaa läpäisseeksi koesarjaksi. Pitkän polun tuotantotuki ja ensimmäisen
tunnistekokeen aikarajaylityksen tarkka syy eivät ratkea tällä näytöllä.

Kuvauksen julkaisu, autentikointikuittaus, natiivibrokeri, apubinäärin
paketointi ja koko Electron-liitos ovat edelleen jatkotyötä. Näissä kokeissa
ei käynnistetä mallia tai eristettyä työntekijää eikä kokeilla verkkoa.

Lähde: [GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo).
