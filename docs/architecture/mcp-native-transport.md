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

Ennen varsinaista käyttöönottoa puuttuvat edelleen alla toteutettujen
kuvaustiedoston julkaisun, lukijan ja Main-tunnisteavun liittäminen,
alla kuvatun Main-yhteyskerroksen liittäminen brokeriin, brokerin hallinta- ja työntekijädatan
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

Alla kuvatun julkaisijan ja Main-yhteyskerroksen liittäminen
natiivibrokeriin, apubinäärin paketointi ja koko Electron-liitos ovat
edelleen jatkotyötä. Näissä kokeissa
ei käynnistetä mallia tai eristettyä työntekijää eikä kokeilla verkkoa.

Lähde: [GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo).


## Mainin autentikoitu TMCT/1-yhteyskerros

`native-main-connection.ts` liittää kertakäyttöisen pääsyoikeuden Mainin
rajattuun binääriseen yhteyteen. Tämä on toteutettu yhteyskerros, ei vielä
oletuskäynnistykseen liitetty palvelin tai natiivibrokeri. Omistajan on
tarjottava oikean kuvaustiedoston poistava `consume`-toiminto ja juuri tämän
backend-sukupolven mitätöivä `revoke`-toiminto. Rajapintatestin synteettinen
poistotoiminto ei todista kuvaustiedoston tuotantojulkaisua tai poistamista.

TMCT on eri protokolla kuin työntekijän TMCP. Tulevan luotetun brokerin
on muodostettava hallintaviestit itse; työntekijän tavuja ei saa tulkita
tai kopioida hallintaotsakkeiksi. REQUEST/RESPONSE sisältävät yhden tiukasti
UTF-8:sta purettavan JSON-viestin, eivät mielivaltaista stream-katkelmaa.
Broker kokoaa työntekijän rivit rajatusti ennen REQUEST-kehystystä ja
palauttaa RESPONSEn työntekijälle rivinä.

Otsake on 16 tavua: ASCII `TMCT`, versio 1, yhden tavun laji, kaksi
nollattua varattua tavua, little-endian payload-pituus ja little-endian
32-bittinen järjestysnumero. Suunnat numeroidaan erikseen yhdestä alkaen;
maksimiarvon jälkeen seuraa nolla. Otsake tarkistetaan ennen payloadin
varaamista. Osittaisen kehyksen kahden sekunnin määräaika ei ala uudelleen
yksittäisistä lisätavuista.

| Laji | Suunta | Payload |
| --- | --- | --- |
| HELLO = 1 | broker → Main | Täsmälleen 48 tavua: sukupolvi 16 ja tunnus 32 |
| ACCEPT = 2 | Main → broker | Täsmälleen 16 tavua: hyväksytty sukupolvi |
| REQUEST = 3 | broker → Main | Yksi kehityspyyntö, 1–16 384 tavua |
| RESPONSE = 4 | Main → broker | Yksi vastaus, 1–65 536 tavua |
| STOP = 5 | Main → broker | Tyhjä |
| CLEAN = 6 | broker → Main | Tyhjä |

HELLO kuluttaa tunnuksen synkronisesti. ACCEPT voidaan lähettää vasta,
kun kuvaustiedoston poistaminen ja backend-asiakkaan liittäminen ovat
onnistuneet. Koko tunnistautumisella on kolmen sekunnin määräaika.
Pyynnön lähettäminen HELLO:n perässä ennen ACCEPTia hylätään. Tila vaihtuu
ACCEPTin lähettämiseksi ennen fyysistä write-kutsua: vastapuoli voi nähdä
kuittauksen ennen paikallisen kirjoituscallbackin valmistumista. Fyysisen
kirjoituksen callbackia ja tarvittavaa drainia odotetaan silti; niiden
virhettä ei tulkita onnistumiseksi.

Yhteys hyväksyy enintään neljä keskeneräistä pyyntöä. Varaus pysyy voimassa
vastauksen fyysiseen valmistumiseen asti, ei vain backend-tuloksen saapumiseen.
Lisäksi sovelletaan 60 pyynnön sekuntirajaa ja 256 viimeisen tunnisteen
toistokieltoa. Fyysisessä FIFO:ssa on enintään kahdeksan kehystä ja 512 KiB
varattuja tavuja; myös Writablen puskuroimat tavut lasketaan konservatiivisesti
mukaan. Kirjoituksen kahden sekunnin määräaika alkaa jonoon hyväksymisestä.

STOP estää uudet pyynnöt synkronisesti ja käynnistää asiakkaan irrotuksen.
Sen rajatun valmistumisen tai epäonnistumisen jälkeen omistajan pitää
mitätöidä backendin sukupolvi. Tämä järjestys estää mitätöintiä muuttamasta
vielä odottavaa oikeaa irrotusta vanhan istunnon virheeksi. Brokerille
annetaan enintään 15 sekuntia CLEAN-ilmoitukseen. Kesken jäävää
kuvaustiedoston poistotoimintoa seurataan erikseen: epävarma valmistuminen
säilyy virheenä, eikä myöhäinen vastaus avaa yhteyttä uudelleen.

CLEAN tarkoittaa **autentikoidun luotetun brokerin ilmoitusta**, että sen
työntekijä on poistunut, Job tyhjentynyt ja omat resurssit siivottu.
Mainin yhteyskerros ei itse todista näitä käyttöjärjestelmähavaintoja.
Brokerin on toteutettava niiden riippumaton tarkistus ennen ilmoitusta;
pelkkä työntekijän kuitti, protokollatulos tai putken EOF ei riitä.

CLEAN voi saapua myös brokerin aloitteesta esimerkiksi MCP-isännän sulkeutuessa.
Se lopettaa uuden työn, hylkää jonossa olevat ja myöhäiset vastaukset,
irrottaa asiakkaan ja sulkee yhteyden. Jokainen sen jälkeinen tavu on
virhe, myös kesken jäävä otsakkeen alku. Todellinen kirjoitusvirhe
säilyy virheenä, vaikka CLEAN olisi saapunut saman write-kutsun aikana.
Pelkkä `destroy()` ei todista streamin sulkeutumista: close-tapahtumaa
odotetaan erikseen rajatusti.

Tulos erottaa `brokerCleanupReported`, `backendDetachSettled`,
`descriptorConsumptionSettled`, `epochRevoked` ja `streamClosed`.
Tunnistautumattoman hylätyn asiakkaan vuoksi ei peruta toisen asiakkaan
käyttämätöntä tunnusta; suorittamattomasta irrotuksesta tai mitätöinnistä
ei raportoida onnistumista. Hyväksytty yhteys on tämän toteutuksen jälkeen
aina päättyvä: tunnusta ei julkaista automaattisesti uudelleen. Uudelleenavaus
vaatii myöhemmin omistajalta edellisen brokerin todellisen siivousnäytön.

Rajattu Windows-näyttö sisältää 12 kehyksen, 35 yhteyden ja 17 aiemman
pääsyoikeuden testiä sekä kolme todellisen paikallisputken integraatiotestiä,
yhteensä 67 läpäissyttä tapausta. Integraatiot käyttävät oikeita
`DevelopmentService`- ja `AssistantService`-osia sekä synteettistä
mallivastaajaa: kaikki neljä UI/MCP:n ristikkäistä luku-/peruutuskieltoa,
aktiivisen MCP-työn peruminen UI-työn jatkuessa ja puutteellisen sulun
erottaminen varmennettiin. Aiemman tyyppitarkistusväitteen oikaisu ja
varmennettu uusinta ovat alla Main-isännän näytössä.
Kolmen uuden ajoitustestin epäonnistunut ajo säilyy erikseen; korjaus
poisti sulun jälkeen jääneen ajastimen sekä kirjoituspoikkeuksen ja
callback-virheen peittymisen.

Alla kuvatun Main-isännän liittäminen sovelluksen käynnistykseen,
apubinäärin paketti, natiivibrokerin TMCT-toteutus, työntekijän käynnistys ja
todellinen siivousnäyttö sekä Electronin oletuspolun liitos puuttuvat vielä.
Tämä näyttö ei hyväksy LPAC:ia, verkkokieltoa, FMI:tä, GPU:ta tai koko
minimipakettia. Kuvaustiedoston puuttuminen ei todista vanhan työntekijän
siivoutumista.

## Suojatun käynnistyskuvauksen julkaisu, kulutus ja palautus

`main-bootstrap.cpp` ja `bootstrap-publication.h` toteuttavat kolme kiinteää
toimintoa: publish, consume ja recover. Apuprosessi käyttää tavallisen
käyttäjän oikeuksia; se ei ole eristetty MCP-työntekijä. Kutsujan on ensin
varmennettava sen ajopaketti. Mainin yhden sovellusinstanssin lukko ja
apukutsujen sarjallistaminen ovat omistajan velvollisuus.

Apuri ei luo tai korjaa käyttöoikeuksia. Se käyttää samaa omistajan,
täsmällisen ACL:n, perinnän ja lukittujen polkukahvojen tarkistusta kuin
lukija. Publish ja consume saavat täsmälleen 96 tavua stdinistä ja vaativat
sen päättymisen. Recoverin uusi lähdesopimus vaatii täsmälleen kahdeksan
ASCII-tavua THREC001 ja EOF:n; se lukee enintään 9 tavua ja hylkää tyhjän,
osittaisen, väärän tai ylimääräisen syötteen ennen palautuksen tiedostokutsuja.
Kehys ei ole salaisuus. Täydellisen kehyksen jälkeen katkennut putki voi
edelleen olla EOF eikä peruuta jo toimitettua valtuutta. Sama alkuperäinen
viiden sekunnin watchdog kattaa myös syötteen odotuksen. Salaisuutta ei anneta
argumenteissa, ympäristössä tai diagnostiikassa.

Muutos on käännetty sovelluspakettiin. Mainin kuljetus- ja valvontalogiikan
56 mocktapausta sekä uuden paketin 13 recover-CLI-tapausta läpäisivät.
Koe erotti tyhjät, osittaiset, väärät, ylimääräiset ja ilman EOF:ää jääneet
syötteet hyväksytyistä kehyksistä ja varmisti kaikkien omien lasten sulun.
Aiemmat paketit käyttävät tyhjää EOF:ää; niitä ei saa kytkeä uuden
säievalvojan recover-pyyntöihin. Varsinainen launch-worker ja sovelluskytkentä
ovat tekemättä. Ensimmäisen raportittoman CLI-epäonnistumisen tuntemattomat
havainnot ja viiveen syy säilyvät avoimina.
Valvojan integraatioportit ja koesarjan tarkat näyttörajat omistaa
[natiiviapurien käynnistysvalvoja](native-launch-supervisor.md).

Publish varmistaa kuvauksen Main-prosessin eläväksi tarkan FILETIMEn avulla.
Se luo vain uuden `main-bootstrap.pending`-tiedoston, kirjoittaa ja huuhtelee
sen sekä tarkistaa tavut samasta kahvasta. Kahvalla tehtävä nimeäminen
lopulliseen nimeen ei saa korvata olemassa olevaa tiedostoa. Esi-isien,
kontrollihakemiston ja tiedoston kahvat säilyvät koko toiminnon ajan.
Nimeämisen jälkeen tiedoston identiteetti, lopullinen polku, omistaja,
ACL, koko ja tavut tarkistetaan ennen kahvan sulkua ja onnistumiskuittausta.
Ennen nimeämistä epäonnistunut toiminto yrittää poistaa vain oman avatun
välitiedostonsa. Epävarma nimeämisen jälkeinen tulos säilytetään palautusta varten.

Consume avaa lopullisen tiedoston ja vertaa kaikkia 96 tavua odotettuun
sukupolveen. Väärä kuvaus säilyy koskemattomana. Poisto tehdään tarkistetulla
kahvalla; onnistuminen vaatii kahvan sulkemisen sekä lopullisen nimen
todetun puuttumisen. Poistomerkintä tai toisen prosessin vielä auki pitämä
tiedosto ei riitä onnistumiskuittaukseen.

Recover on käynnistyksen rajattu kuvaustiedostojen palautus. Elävä ja
tarkkaa käynnistysaikaa vastaava Main estää poiston. Puuttuva PID,
eri käynnistysaika tai kahvasta todettu prosessin poistuminen sallii
muuten hyväksytyn vanhan kuvauksen poistamisen. Prosessikyselyn
käyttöoikeusvirhe ja muut epävarmat tulokset estävät palautuksen.
Prosessikahva säilyy päätöksen ja poiston ajan.

Varattu välitiedosto saa olla kesken jäänyt. Tunnettujen otsaketavujen
täytyy täsmätä, koko ei saa ylittää 96 tavua, ja saatavilla oleva kokonainen
Main-tunniste tarkistetaan. Alle 32 tavusta omistajasukupolvea ei voida
todentaa: sen poistaminen perustuu varatun kertakäyttöisen välitiedoston
sopimukseen, omistajan instanssilukkoon ja sarjallistamiseen. Auki oleva
kirjoittava julkaisukahva estää palautuksen. Muoto-, linkki-, polku- tai
ACL-virheitä ei korjata eikä tulkita vanhentumiseksi.

Apurin oma viiden sekunnin määräaika kattaa stdin-, tiedosto- ja tulostusodotukset.
`native-bootstrap-operation.ts` rajaa lapsiympäristön, syötteen ja tulosteet,
odottaa prosessin todellisen sulkeutumisen ja käyttää kuuden sekunnin
ulompaa aikarajaa. Peruuttaminen tai aikaraja yrittää pysäyttää lapsen;
havaitsematon poistuminen palautuu erikseen epävarmana. Kuittauksen
katoaminen voi tarkoittaa jo tehtyä tiedostomuutosta, joten kutsua ei
saa toistaa automaattisesti onnistumisen olettamiseksi.

Laajennettu Windows-koe läpäisi kokonaisuudessaan 47/47 tapausta:
aiemmat 22 lukija-/tunnistetapausta ja 25 julkaisu-/kulutus-/palautustapausta.
Mukana ovat todellinen Main-kutsusovitin, säilytettävä vanha tiedosto,
väärä sukupolvi, elävä/poistunut/eri-ikäinen prosessi, kielletty prosessikysely,
vajaa välitiedosto, ristiriitaiset kahvat, kova linkki, virheellinen syöte,
jumittunut stdin ja kadonnut tulostekuittaus. Lisäksi 12 sovittimen
yksikkötestiä läpäisivät. Aiemman tyyppitarkistusväitteen oikaisu ja
varmennettu uusinta ovat alla Main-isännän näytössä.
Rakennuskuitti sitoo 16 lähdesyötettä ja kolme koebinääriä.

Kaksi epäonnistunutta yritystä säilyvät erillisinä: testin valmistelun
aikarajaylitys sekä 44/47-tuloksen suhteellisen nimeämiskutsun virhe 87.
Ensimmäisen tarkkaa syytä ei tunneta. Nimeäminen korjattiin absoluuttiseen
laajennettuun polkuun; kahvalukkoja tai korvaamiskieltoa ei poistettu.
Testin valmistelulle annettiin erillinen pidempi määräaika; tuotannon
apurin aikarajat säilyivät ennallaan.

Tämä palautus todistaa vain kuvaustiedostojen tilanteen. Se ei todista
vanhan brokerin, työntekijän tai Jobin siivousta eikä valtuuta uuden
istunnon avaamista. Alla kuvattujen Main-isännän ja apupaketin liitos,
natiivibrokeri ja koko sovelluksen OS-/verkko-/FMI-/CPU-/GPU-näyttö ovat
edelleen jatkotyötä.

Windows-sopimukset:
[FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info),
[SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle) ja
[OpenProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocess).

## Yhden avauksen Main-isäntä

`NativeDevelopmentHost` liittää tunnistautumisen, oikean kuvaustiedoston
käsittelyn ja paikallisen putken samaan elinkaareen. Se on vielä erillinen
koostamisvaihtoehto; oletusentry käyttää edelleen aiempaa isäntää.
`development-owner.ts` sallii yhdelle backend-oliolle vain yhden legacy-
tai native-isännän koko olion eliniän ajan. Sulku tai statuskysely ei
vapauta tätä omistusta. Koostamisen ei pidä kiertää sitä portin aliasolioilla.

Main omistaa kiinteän yksityisen kontrollihakemiston ja sovelluksen
instanssilukon. Ennen julkaisua luodaan vain uutena
`native-session-reserved`-hakemisto. Olemassa oleva varaus estää avauksen.
Varaus voidaan poistaa vain alla kuvatulla natiivilla pristine-polulla,
kun broker ei ole liittynyt sessioniin. Onnistunut CLEAN ei yksin vapauta
BROKER_ADMITTED-varausta, eikä tilalle valita uutta satunnaishakemistoa.
Brokerin varmennettu vapautus, palautus ja uudelleenavaus ovat jäljellä
olevia toteutusportteja.

Avaus etenee varauksesta kuvaustiedoston palautukseen, tarkkaan Main-tunnisteeseen
ja liittymislippuun sekä native-prepareen. Sen jälkeen valmistellaan suljettu
worker-paketti ja sinetöidään session. Vasta sitten määritetään backendin
istunto, avataan kuunteleva putki ja julkaistaan kuvaus. Kaikkien odotusten
jälkeen tarkistetaan peruutus. Putken kokonaisyhteysraja on neljä;
kuudestoista hyväksyntä on viimeinen samassa sekunnin laskentaikkunassa.
Väärä tunnistautumaton asiakas ei kuluta oikean asiakkaan tunnusta.
Jos kuvaus näkyy ennen julkaisijan poistumista, sen kulutus odottaa
julkaisutyön valmistumista. ACCEPT odottaa edelleen kulutusta ja liittämistä.

Sulku julkaisee yhteisen lupauksensa ennen peruuttamisen sivuvaikutuksia.
Kuuntelija ja backendin irrotus–mitätöinti eivät odota jumittunutta
tiedostojulkaisua. Kesken oleva listen/configure odotetaan omassa sulussaan,
jotta myöhäinen valmistuminen ei palauta resurssia. Koko sulun 30 sekunnin
määräajan jälkeen ei käynnistetä uutta apuprosessia; peruutus tarkistetaan
myös asynkronisen pakettitarkistuksen jälkeen. Epävarma apurin poistuminen
estää uuden tiedosto-operaation. Tulos erottelee kuvaustiedoston havaitun
puuttumisen, apurin poistumisen, kuuntelijan sulun, backendin mitätöinnin,
brokerin ilmoituksen ja tämän isännän todella luoman varauksen.

`native-mcp-helpers.ts` tarkistaa suljetun kahden apubinäärin hakemiston
luotetun koostamisen antamiin koko-/SHA-256-pinneihin. Paketti tarkistetaan
ennen jokaista kutsua; linkit, muuttuneet tiedostot ja lisäsisältö hylätään.
Paketista itsestään luettu tarkiste ei kelpaa luottamusjuureksi. Tämä ei
ole allekirjoitus eikä Windowsin kirjoitus-/poistokahvalla lukittu
suoritustiedosto. Saman käyttäjän tai ylläpitäjän haitalliset muutokset
eivät kuulu tässä torjuttuihin muutoksiin.

Rajattu Windows-näyttö: 71/71 testiä läpäisi. Mukana ovat oikeat kaksi
apubinääriä, suojattu tiedosto, paikallinen putki ja backend-palvelut sekä
synteettinen broker-vastapää. Aiemman viestikehyksen 12 ja yhteyskerroksen
35 testiä, kaksi legacy-isännän testiä, kaksi apupaketin peruutustestiä
sekä 20 isännän/paketin integraatiotapausta läpäisivät. Koepuut poistuivat.
Kokeen käynnistin sitoo tarkistetut lähdesyötteet koko ajon ajaksi. Kokeet eivät käynnistä
eristettyä MCP-työntekijää tai todista CLEANin taustalla olevaa Job-siistiytymistä.

Kaksi sulkuvirhettä toistettiin ennen korjausta: 17/18-ajossa julkaisu
esti kuuntelijan sulun ja epochin mitätöinnin; 23/24-ajossa myöhäinen
julkaisu aloitti consume-kutsun sulun määräajan jälkeen. Epäonnistuneet
raportit säilyvät erillisinä.

**Tyyppitarkistusnäytön oikaisu:** aiemmat suoran PowerShell/Node-kutsun
exit0-havainnot eivät todistaneet kääntäjän onnistumista: kutsu ei palauttanut
Noden tulostetta eikä LASTEXITCODE-arvoa. Tarkkaa käynnistyssyytä ei ole
osoitettu. Prosessikahvan säilyttävä, poistumista odottava ja tulosteet
tallentava uusinta löysi viestikehyksen Map-tyypityksen virheen ja
yhteystestin kehämäisen fixture-tyypin. Ne korjattiin muuttamatta runtime-
käytöstä. Nykyinen desktop-käännös, integraatiotestien tyyppitarkistus ja
laajennettu yksikkötestien tyyppitarkistus palauttivat kaikki todennetun
exit0:n. Vanhoja AF/AG-tyyppiväitteitä ei käytetä itsenäisenä näyttönä.

Uudelleenavaus, toimitettavan apupaketin rakentaminen, oikea natiivibrokeri,
workerin käyttöjärjestelmärajat ja itsenäinen siivousnäyttö sekä Electronin
oletuspolku ja alkuperäinen FMI/verkko/CPU/GPU-minimipaketti ovat kesken.

Main-isännän julkinen koeresepti on
`tests/integration/mcp/run-native-host.ps1`. Sen `-BootstrapRun`-argumentti
valitsee aiemman onnistuneen `run-native-bootstrap.ps1`-ajon run-hakemiston.
Resepti tarkistaa sen 47 tapauksen kuitin, molemmat apubinäärit ja lähdepinnit,
ajaa nykyisen 84 tapauksen valinnan yhdellä suorittimella ja kirjoittaa uuden
yksityisen kuitin. Valinta on 26 Host-, 42 yhteys-, 12 viestikehys-, kaksi
legacy-isännän ja kaksi apupaketin tapausta. Puuttuvat ympäristöehdot tai
ohitetut tapaukset eivät kelpaa onnistumiseksi. Aiempi 71/71 on historiallista
näyttöä; korjatun 84 tapauksen kokonaisreseptin ajoa ei ole tehty tässä muutoksessa.


## Jaetut Windowsin omistus- ja sulkutarkistukset

MCP:n natiivibrokerin valmistelu jakaa backendin kanssa kolme pientä
`packages/windows-runtime/native`-otsaketta. `owner-security.h` tunnistaa
nykyisen käyttäjän ja omistaa SID-varaukset; se ei myönnä tiedosto-oikeuksia.
`process-witness.h` tarkistaa aiemmin kirjatun prosessin poistumisen tarkan
PID:n ja luontiajan avulla. Avaamisen virhekoodi ei yksin todista poistumista:
varareitti vaatii kokonaisen prosessiluettelon ja siinä myös oman prosessin.
`owned-job.h` luo tai avaa nimetyn Jobin, tarkistaa omistajan ja täsmällisen
owner/SYSTEM-ACL:n, rajoitukset ja kahvan periytymättömyyden sekä odottaa
rajatusti Jobin tyhjenemistä.

Jobin nimi ja käytettävä rajoituspolitiikka tulevat luotetulta omistavalta
moduulilta, eivät työntekijältä. Backendin ohuet vanhan nimiset portit
säilyttävät sen nimeämisen, yhden prosessin rajan, yhden suorittimen,
BelowNormal-prioriteetin, 512 MiB:n prosessimuistirajan ja kill-on-close-säännön.
Muutoksen yhteydessä natiivibinäärit käännetään uudelleen; vanhojen binäärien
ABI-yhteensopivuutta ei luvata. Backendin rakennuskuitti sitoo myös nämä
kolme jaettua lähdeotsaketta.

Backendin tiedostopuu, tiedosto-ACL:t, journalin tilakone, havaintopaikkojen
siirto ja käyttäjätiedon oikeudet pysyvät backendin omistamina. MCP tarvitsee
oman resurssipuun, journalin ja TMCT/TMCP-välityksen. Käynnistyskuvauksen
ACL-sopimusta ei yhdistetä runtime-resurssien ACL-sopimukseen. Tämä irrotus ei
vapauta Mainin pysyvää varausta eikä vielä todista MCP-työntekijän eristystä.


Irrotuksen rajattu Windows-varmennus läpäisi neljä kokonaista testisarjaa:
aiemmat prosessin palautus-, tiedostopolku- ja havaintopaikkojen siirtotestit
sekä uusi tyhjien Jobien testi. Viimeinen käyttää vain yhteisiä otsakkeita,
ei backendin sisäisiä otsakkeita. Se tarkistaa uuden Jobin, nimitörmäyksen,
oikean palautusavauksen, väärän rajoituspolitiikan, periytyvän kahvan,
muuttuneen rajan ja viimeisen kahvan sulkeutumisen jälkeisen puuttumisen.
Backend-broker ja kaikki neljä testiohjelmaa kääntyivät varoitukset virheiksi
käsittelevällä asetuksella. Kaikkien viiden prosessiajon exit0 havaittiin
säilytetyistä prosessikahvoista. Varsinaista backend-palvelua ei ajettu.

Ensimmäinen yritys säilyy epäonnistuneena: palautustesti tulosti onnistumisen,
mutta ylitti testikäynnistimen 15 sekunnin kokonaisrajan; exit0 havaittiin
vasta siivousvaiheessa. Tarkkaa hidastumisen syytä ei osoitettu. Onnistuneessa
uusinnassa testiprosessin ulkoraja oli 45 sekuntia. Tuotannon määräaikoja,
backendin oikeuksia tai oletuskäynnistystä ei muutettu. Lähde- ja
rakennussyötteiden tarkisteet varmennettiin ajon ympärillä.

## Välittäjän lähdetoteutus ja rajattu sulkunäyttö

MCP:n natiivivälittäjän lähdetoteutus on `apps/mcp/native/mcp-broker.cpp`.
Se on vielä toteutuskandidaatti: eristetyn Node-työntekijän käynnistystä,
palautusta tai Electronin oletuspolun liitosta ei ole hyväksytty.

Välittäjä ottaa vain Mainin kiinteän käynnistyskuvauksen. Se todentaa Mainin,
välittää TMCT/1-hallinnan ja TMCP/1-työntekijävirrat sekä valmistelee vain
oman varauksen alaisen kiinteän worker/package/scratch-puun.
Työntekijä ei valitse suoritettavaa tiedostoa, ajoprofiilia tai Jobin nimeä.

Kertakäyttöinen journal kirjoitetaan ja huuhdellaan ennen profiilin ja
prosessin luontiyritystä. Prosessin tarkka tunniste tallennetaan ennen
jatkamista. Epävarma luontivaihe tai epäonnistunut journal ei oikeuta
CLEANiin tai automaattiseen uudelleenyritykseen. Mainin pysyvä varaus
säilyy. Nämä ovat lähteeseen toteutettuja ehtoja; niiden OS-ajon näyttö puuttuu.

Kirjoituksen kahden sekunnin raja kattaa jonotuksen, fyysisen I/O:n ja
valmistumisen havainnon ennen jonovarauksen vapautusta. Sulussa
prosessin exit0 ei yksin riitä: saman alkuperäisen kahden sekunnin
budjetin sisällä odotetaan kirjoitusjonon tyhjeneminen sekä stdoutin ja
stderrin EOF. Osittainen TMCP-kehys ja yli 16 KiB:n yhteenlaskettu stderr
säilyttävät virheen myös onnistuneen resurssisiivouksen jälkeen.

Windowsin rajatussa putkikokeessa viestimuodon testisarja ja 14 I/O-tapausta
läpäisivät. Mukana ovat myöhäisen onnistuneen kirjoituksen havainto,
todellinen putkitakapaine, ennen viimeisten tavujen lukua poistunut
synteettinen lapsi, osittainen otsake/runko/loppukehys sekä 16 384 ja
16 385 stderr-tavun sulut. Käännöksen ja molempien testiohjelmien
exit0 todennettiin säilytetyistä prosessikahvoista.
Oikeaa välittäjää, mallia tai LPAC-profiilia ei käynnistetty tässä kokeessa.

Main hyväksyy sulun aikana enintään kahdeksan muuten validoitua myöhäistä
pyyntöä vain poisheitettäviksi. Niitä ei suoriteta, niihin ei vastata
eikä sulkumääräaikaa uusita. Virheellinen tai yhdeksäs pyyntö epäonnistuu.
Yhteyden 42 testiä ja kolme kohdistettua tyyppitarkistusta läpäisivät.

Havaintoapurin kaksi kokonaisajoa jäivät epäonnistuneiksi: käännöksen exit0:n
jälkeen erillinen havaintoapuri ei ollut luettavissa, ja se oli siirtynyt
virustorjunnan karanteeniin ennen suorittamista. Väärää hälytystä ei ole
vahvistettu. Myöhemmän putkikokeen onnistuminen ei hyväksy tätä apuria.
Sen live-journalin jakamissopimus ja Job-havainnon elinkaarivaikutus
tarvitsevat lisäksi korjauksen tai tarkemman koesopimuksen.

Natiivipaketin liitos sovellukseen, oikean työntekijän toiminta ja ulkopuolinen
prosessi-/Job-/profiili-/tiedostohavainto, palautus ja uudelleenavaus sekä
alkuperäinen FMI/verkko/CPU/GPU-minimipaketti ovat edelleen kesken.

## Natiivipaketin rakennusresepti

`scripts/native/build-mcp-native.ps1` kokoaa välittäjän ja Main-apurit
aiemmin hyväksytystä MCP-työntekijäpaketista. Parametrit ovat
`-WorkerBuild` (kiinteä `build-<32 pientä heksamerkkiä>`) ja
`-WorkerDigest` (luotetusti annettu manifestin SHA-256). Rakentaja ei
valitse uusinta hakemistoa tai hyväksy donorin omaa ilmoitusta luottamusjuureksi.

Tuloksena on uusi yksityinen rakennushakemisto:

- `bin/mcp-broker.exe`
- `helpers/main-bootstrap.exe` ja `helpers/main-identity.exe`
- `package/`: työntekijäpaketin kahdeksan tiedostoa muuttumattomina
- erilliset lähde-, työkalu- ja binääripinnit, lokit, rakennusmanifesti ja
  `runtime-descriptor.json`

Apurihakemistossa ei ole muita tiedostoja. Workerille annettava paketti
ei sisällä välittäjää, apureita tai rakennusmetadataa. Rakennushakemisto
luodaan owner/SYSTEM-oikeuksin; runtime-grantit ovat erillinen myöhempi vaihe.

`prepare-mcp-native.mjs` tarkistaa donorin ja kopioidut tavut, generoi
C++-pinnit tarkistetusta manifestista sekä varmistaa lopuksi suljetun puun,
single-link-tiedostot ja binäärien ulkoa sidotut pinnit. PowerShell sitoo
projektin koko natiivin include-ketjun ja tarkistaa lähteet, paketin sekä
työkalupinnit vaiheiden ympärillä. Käännös käyttää olemassa olevaa MSVC:tä
ja Windows SDK:ta. Resepti ei asenna työkaluja eikä suorita tuottamiaan ohjelmia.

Kuvaustiedosto siirretään lopulliseen nimeen vasta tarkistusten jälkeen,
ilman olemassa olevan tiedoston korvaamista. Sen olemassaolo ei yksin
todista onnistumista: hyväksyntä tarvitsee myös koko ajon todellisen exit0:n,
onnistuneen loppukuitin ja täsmäävät pinnit. Mainin tuleva composition
tarvitsee luotetun ulkoisen descriptor-pinnin; itse paketti ei ole
allekirjoitus. Kaikkien SDK-/CRT-syötteiden täydellistä sulkemista tai
toistettavaa binäärirakennusta ei luvata.

Rajattu Windows-käännös ja paketin lopputarkistus läpäisivät. Kolmen
binäärin tarkisteet kirjattiin, ja nykyinen apulataaja hyväksyi täsmälleen
kahden tiedoston hakemiston kutsumatta apureita. 27 pakettitapausta
läpäisi ilman ohituksia: 12 aiempaa pakettitestiä, 11 uutta valmistelu- ja
lopputarkistuksen tapausta sekä neljä kootun apupaketin lataajatestiä.
Lataajatesti estää kaikki prosessikäynnistykset. Tämä hyväksyy vain
rakennus- ja pakettirajan, ei välittäjän käynnistystä tai OS-eristystä.

Ensimmäinen yritys säilyy epäonnistuneena: valmistelu onnistui, mutta
työkalun hakuvaihe epäonnistui PowerShellin yhdistäessä komennot yhdeksi
riviksi. Reseptin taulukko korjattiin ja UTF-8 asetettiin erikseen.
Epäonnistunut ajo ei julkaissut lopullista tai pending-kuvausta.


## Oikean työntekijän toiminnallinen sulkukoe

`tests/integration/mcp/native-broker.integration.test.ts` on erikseen
käynnistettävä Windows-koe. Se käyttää tarkistettua natiivipakettia,
oikeaa Main-isäntää ja MCP-työntekijää sekä DevelopmentService- ja
AssistantService-sovelluspalveluja synteettisellä mallimoottorilla.
Kokeessa suoritetaan MCP:n alustus, työkalulista ja `model_status`.
Tilakyselyn pitää kulkea backendin kehityspalveluun ilman malliajon käynnistystä.

Koe pitää asiakkaan stdin-virran auki ja pyytää sen jälkeen Mainilta sulun.
Onnistuminen edellyttää välittäjän todellista exit0:aa, stdout-EOF:ää,
virheetöntä Main-sulkutulosta, backend-oikeuden mitätöintiä ja kuuntelijan
sulkeutumista. Välittäjän poistumisen jälkeen tarkistetaan journalin
CLEAN-vaihe, tarkiste ja ajokonteksti sekä käynnistyskuvauksen ja worker-puun
puuttuminen. Pysyvä varaus ja journal säilytetään myös onnistumisessa.
Koe ei käynnistä palautusta eikä valmistele tuotannon uudelleenavausta.

Korjattu rajattu Windows-koe läpäisi yhden tapauksen ilman ohituksia.
Testiprosessin ja koko koeajurin todelliset exit0:t havaittiin;
lähde- ja pakettipinnit täsmäsivät ajon jälkeen. Malliajoja ei syntynyt,
stdout päättyi, eikä pakkopysäytystä tai siivousvirhettä havaittu.
Kohdistettu integraatiotestien tyyppitarkistus läpäisi.

Ensimmäinen kokonaisajo epäonnistui testin liian tiukkaan stdin-close-
tapahtuman järjestysvaatimukseen. Tilakierros, välittäjän exit0 ja Mainin
sulkutulos oli havaittu, mutta ne eivät muuta epäonnistunutta ajoa hyväksytyksi.
Korjattu testi edellyttää stdin-virran olevan auki Main-STOPin hetkellä ja
välittäjän päättyvän sen jälkeen. Mahdollinen stdin-close saa tapahtua vasta
STOPin jälkeen; sen puuttuminen ennen child-closea ei yksin ole virhe.

Tämä on Node-isännän toiminnallinen koe. Välittäjän oma CLEAN-ilmoitus ja
paikallinen tiedostojälki eivät ole riippumaton prosessi-, Job-, profiili-
tai verkkorajan havainto. Electronin oletuspolku, palautus ja uudelleenavaus
sekä koko FMI/verkko/CPU/GPU-koepaketti tarvitsevat edelleen oman näyttönsä.
Erillistä karanteeniin joutunutta havaintoapuria ei käytetä tässä kokeessa.


## Toimitettavan MCP-paketin valmistelu ennen julkaisua

`native-mcp-resources.ts` lataa Mainin luotetun koostamisen valitseman
natiivipaketin. Pakollinen `descriptorSha256` annetaan paketin ulkopuolelta;
kuvaustiedoston oma tarkiste ei kelpaa hyväksymisperusteeksi. Lataus tarkistaa
sidotun rakennusmanifestin, kiinteän broker-binäärin, kaksi apuria sekä
worker-paketin kahdeksan tiedostoa. Runtime ei importoi rakennusskriptejä.
Binääri- ja helper-hakemistojen sekä worker-puun ylimääräinen sisältö,
linkit, väärät tavut ja yhteensopimaton metadata hylätään.

Main-isännän pakollinen resurssiportti sisältää apurit ja
`prepareWorker`-toiminnon. Valmistelu suoritetaan ennen Main-tunnistetta,
backendin asetusta, kuuntelijan avausta ja käynnistyskuvauksen julkaisua.
Näin ulkoinen MCP-asiakas ei pääse aloittamaan välittäjää keskeneräisestä
paketista. Pelkät apurit ilman valmisteluriippuvuutta eivät kelpaa portiksi.
Synteettisen vastapään testeissä valmistelu korvataan eksplisiittisesti;
oikean brokerin koe käyttää tuotannon lataajaa ja valmistelua.

Valmistelu kirjoittaa vain Mainin uutena luoman kiinteän varauksen
`worker/package/licenses`- ja `worker/scratch`-puun. Olemassa olevaan kohteeseen
ei yhdistetä mitään. Hakemistot perivät owner/SYSTEM-oikeudet; niille ei
aseteta erillistä suojattua ACL:ää tai työntekijän oikeuksia. Broker omistaa
myöhemmät grantit, profiilin, Jobin, journalin ja työntekijän sulun.

Lähdepaketti tarkistetaan uudelleen ennen valmistelua ja sen lopuksi;
kopioitu sisältö varmennetaan ennen valmistelun valmistumista. Peruutus ja
valmistelun 30 sekunnin määräaika estävät seuraavan sivuvaikutuksen myös
keskeyttämättömän kopioinnin valmistuessa myöhään. Kesken oleva lupaus
pysyy isännän seurannassa: aikarajan kuluminen ei todista sen loppumista.
Osittainen worker-puu ja pysyvä varaus säilyvät virheessä. Valmistelutoiminto
ei poista tiedostoja, käynnistä prosessia tai tee automaattista palautusta.

Rajattu Windows-varmennus läpäisi 43 tapausta: 17 paketinlataajan ja
valmistelun tiedostokoetta sekä 26 Main-isännän tapausta oikeilla apureilla
ja synteettisellä broker-vastapäällä. Mukana on myös koko sulkuajan ylittävä
valmistelulupaus ja myöhäisen valmistumisen esto. Tuotannon desktop-käännös
sekä integraatio- ja yksikkötestien kohdistetut tyyppitarkistukset läpäisivät.

Oikean brokerin yhden tapauksen koostumiskoe läpäisi tuotantoloaderilla ja
Mainin valmisteluportilla ilman testin omaa pakettikopiointia. Worker oli
valmis Mainin avauksen valmistuessa; oikea julkaisutyökalu, MCP-tilakierros
ja Main-STOP toimivat. Testiprosessien ja ulompien ajurien todelliset exit0:t
havaittiin ja 570 lähde-/pakettipinniä täsmäsivät ajon jälkeen. Mallia,
sää-APIa tai karanteeniapuria ei käytetty. Siivouksen näyttöraja on sama
kuin edellä: brokerin ilmoitus ja paikallinen jälkitila.

Sovelluksen oletusentry, palautus/uudelleenavaus ja riippumaton
OS-/verkkonäyttö sekä koko FMI/CPU/GPU-koepaketti ovat kesken.


## Vapautuksen omistajuusjournal v2

`broker-journal-codec.h` määrittää uuden 1024 tavun tietueen. `TMCJRN2` ja
versionumero 2 erottavat sen aiemmasta journalista; TMCT/1- ja TMCP/1-
viestikehykset sekä paketin kuvausskeema pysyvät ennallaan. Vanhaa journalia
ei muuteta eikä tulkita uuden version poistumisnäytöksi.

| Tavukohta | Kenttä |
| --- | --- |
| 0–19 | Magic, versio, koko ja vaihe |
| 20–47 | Brokerin/Mainin/workerin PID:t sekä Mainin ja workerin FILETIME:t |
| 48–75 | Generation ja worker-stagen volume/indexHigh/indexLow |
| 76–79 | Varattu nollatäyte |
| 80–143 | Paketin digest |
| 144–503 | Pituusrajatut owner- ja profile-SID:t nollatäytteineen |
| 504–511 | Brokerin oma FILETIME |
| 512–523 | Reservationin volume/indexHigh/indexLow |
| 524–991 | Varattu nollatäyte |
| 992–1023 | SHA-256 ensimmäisistä 992 tavusta |

Brokerin tunniste tulee sen omasta prosessista ja reservationin tunniste
jo varmennetusta kansiokahvasta. Historiallisia tunnisteita ei tyhjennetä
CLEANissa. Tietueen eheys ei yksin todista omistajuutta tai prosessin
poistumista. Codec tarkistaa vaiheiden kenttäyhdistelmät; niiden sallittu
siirtymäjärjestys kuuluu edelleen `BrokerJournal`-omistajalle.
`ProfileCreating` ja `ProcessCreating` säilyvät epävarmoina vaiheina.

`broker-journal-store.h` erottaa tallennusportin: varmennus → kirjoitus →
flush → takaisinluku → varmennus. Virhe myrkyttää kirjoittajan: seuraavaa
vaihetta, kirjoitusta tai vanhaa onnistunutta tietuetta ei enää luovuteta.
Tuotanto käyttää olemassa olevaa BCrypt-SHA-256-funktiota ja säilytettyä
natiivia tiedostokahvaa. Testien tarkistefunktio on erikseen nimetty
riippuvuuskorvaus, eikä sen tulosta kuvata kryptografiseksi näytöksi.

Siirrettävä C++-koe läpäisi 55 tavumuoto- ja tallennusvirhetapausta yhdellä
suorittimella. Se ei ajanut Windows-APIa tai profiilia. Ensimmäinen käännös
pysähtyi varoitukset virheinä käsitteleviin luettavuuskohtiin; korjattu
käännös ja testi päättyivät todellisiin exit0-havaintoihin. Windowsin
kolmen binäärin käännös, pakettitarkistus ja uuden tietueen yhden tapauksen
oikea broker-koostumiskoe läpäisivät. Testiprosessin ja ulomman ajurin
exit0:t havaittiin, ja 572 lähde-/pakettipinniä täsmäsivät ajon jälkeen.
Koe tarkisti broker-PID:n käynnistettyä lasta vasten, stage/reservation-
tunnisteet Windowsin Node BigIntStats -arvoihin sekä journalin eheyden,
Main-kontekstin ja MCP-tilakierroksen sulkuineen. Brokerin FILETIME:sta
varmennettiin vain ei-nolla; sen täsmällinen ulkopuolinen vastaavuus on
vielä avoin. Kohdistettu integraatiotestien tyyppitarkistus läpäisi.
Tämä ei vielä hyväksy varauksen vapautusta tai kaatumispalautusta.

Normaalin CLEANin jälkeisen erillisen natiivivapautuksen sopimuksen ja
profiilitarkistuksen näyttörajan omistaa [liittyneen sessionin vapautus](mcp-clean-release.md).
Mainin boolean tai Node-rm ei vapauta varausta. Saman Main-omistajan
sukupolvien hallinta, kaatumispalautus ja sovelluksen restart ovat vielä
toteutettavia portteja.

Profiilin SID:n johtaminen ei ole profiilin puuttumistodiste.
[Microsoftin DeleteAppContainerProfile-sopimus](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-deleteappcontainerprofile)
kuvaa olemattoman profiilin poiston onnistuvan, mutta epäonnistuminen
jättää tilan määrittelemättömäksi. Tuleva palautus käsittelee tämän
rajattuna omistusoperaationa; polkukysely ei korvaa sitä.


## Pysyvä session sidonta ennen liittymistä

Mainin natiivinen Host käyttää pakollista resources.session-porttia.
Tuotantoloader tarkistaa ulkoiseen descriptor-pinniin sidotun brokerin
uudelleen ennen jokaista operaatiota ja kopioi 96 syötetavua ennen
asynkronisia tarkistuksia. Portilla on neljä kiinteää operaatiota:

1. Main luo uuden pysyvän varauksen, selvittää oman identiteettinsä ja
   muodostaa liittymislipun ilman backend-kutsua. Brokerin --prepare
   luo control-juureen uuden leasen ja PREPARING-tietueen ennen stagen kopiointia.
2. Paketin valmistelun jälkeen --seal varmentaa saman kontekstin,
   varauksen, kahdeksan tiedoston worker-paketin ja tyhjän scratchin.
   Vain kokonaan onnistunut tarkistus ja pysyvä takaisinluku tuottavat READYn.
3. Backendin configure, kuuntelija ja --publish seuraavat tätä.
   Julkaisija pitää leasen READY-tarkistuksesta descriptorin renameen,
   takaisinlukuun ja descriptor-kahvan sulkuun. Lease ja muut session
   kahvat suljetaan ennen helperin onnistumiskuittausta.
4. --release-pristine vapauttaa erillisen intent-/completion-protokollan kautta
   vain READY-sessionin, johon broker ei ole liittynyt. Sen rajat ja näyttö
   kuvataan [pristine-vapautuksessa](#pristine-vapautus-ja-todennettu-näyttö).

Nämä moodit kuuluvat pakettiin sidottuun mcp-broker.exe:en. Ne
dispatchataan ennen tavallisen brokerin stdio-/Main-/worker-elinkaarta.
Ne eivät yhdistä Main-putkeen, luo profiilia/Jobia tai käynnistä workeria.
Generic main-bootstrap.exe säilyy descriptor-only-apurina.
Sen publish ei muodosta READY-sidontaa; consume poistaa edelleen vain
täsmälleen odotetut 96 tavua. Consume ei ota session leasea, koska Mainin
ACCEPT muuten odottaisi brokerin pitämää lukkoa.

native-session.lease sijaitsee varauksen ulkopuolella. Sen kahva avataan
todellisella GENERIC_READ/GENERIC_WRITE-oikeudella ja share=0:lla.
Hakemistojen metadata-kahvat eivät korvaa tätä lukkoa. BootstrapPinin
oletusjakaminen säilyy ennallaan; eksplisiittinen nolla välitetään nollana.
Lease sisältää kiinteän 32-tavuisen headerin. Tiedosto, identiteetti,
owner/SYSTEM-DACL ja header varmistetaan. Nykyinen prepare on CREATE_NEW:
aiempaa leasea tai osittaista tietuetta ei korjata tai ohiteta.

native-session.bin on myös control-juuressa ja sisältää 1024 tavua:

| Tavukohta | Kenttä |
| --- | --- |
| 0–31 | TMCSES1, versio, koko, vaihe ja Mainin PID/FILETIME |
| 32–47 | Generation |
| 48–95 | Controlin, reservationin, stagen ja leasen volume/indexHigh/indexLow |
| 96–111 | Brokerin PID, nollatäyte ja FILETIME |
| 112–175 | Paketin digest |
| 176–371 | Owner-SID:n pituus ja enintään 192 tavua nollatäytteineen |
| 372–383 | Varattu nollatäyte |
| 384–415 | Alkuperäisten 96 descriptor-tavun SHA-256 |
| 416–991 | Varattu nollatäyte |
| 992–1023 | SHA-256 ensimmäisistä 992 tavusta |

BrokerSessionStore omistaa tietueen luku-/kirjoitussopimuksen. Lataus ja
commit varmentavat tiedostoa sekä ennen I/O:ta että takaisinluvun yhteydessä;
commit sisältää kirjoituksen ja flushin. Jokainen virhe myrkyttää kyseisen
store-olion: aiempi onnistunut tietue ei jää käytettäväksi eikä seuraava
kutsu aloita uutta I/O:ta. Vaiheiden sallittu järjestys kuuluu omistavalle
session-operaatiolle. Virheellinen tai osittainen pysyvä tila säilytetään;
store ei korjaa sitä tai anna varauksen poistovaltuutta.

PREPARINGissa stage-identiteetti on vielä tyhjä. READY sitoo sen, mutta
ei sisällä broker-identiteettiä. Tavallinen broker ottaa saman leasen
ennen Main-yhteyttä ja HELLOa, vertaa READY-kontekstia ja varsinaisia
hakemistoidentiteettejä sekä tallentaa oman PID/FILETIME-parinsa pysyvään
BROKER_ADMITTED-vaiheeseen. Descriptor-digest sitoo myös pipe-noncen ja
liittymislipun tallentamatta lippua session-tietueeseen.

Vain sharing violation on leasen odotuksessa uusittava kilpailu.
Odotus ja koko admission-vaihe rajataan viiteen sekuntiin alkuperäisen
startup-budjetin sisällä. Rajat tarkistetaan ennen avausyritystä,
onnistumisen/varmennuksen jälkeen sekä ennen admission-kirjausta ja sen
jälkeen. Myöhäinen tai epävarma kirjoitus ei johda HELLOon. Natiivisten
helper-moodien oma kova määräaika on viisi sekuntia, Node-omistajan
poistumishavainnon määräaika kuusi; kuittirivi ei korvaa todellista exit0:aa.

Broker pitää leasen resurssielinkaaren yli. Resurssien identiteetit
verrataan vielä sessioniin ennen journalin luontia, ja Mainin elossaolo
tarkistetaan resurssien avaamisen molemmin puolin. Worker ei peri leasea
tai session-kahvaa. Worker/process/Job, journal, resurssit ja Main-peer
suljetaan ennen session-kahvaa ja viimeisenä leasea. Leasen saaminen ei
yksin todista brokerin poistumista; natiivi vapautus tarvitsee tuoreen
PID/FILETIME- ja poistumishavainnon.

## Session-perustan todennettu näyttö ja rajat

Siirrettävä C++-koe läpäisi 37 tapausta: 19 codecin ja 18 tallennusportin
tapausta. Mukana ovat luku-, varmistus-, kirjoitus-, flush- ja takaisinlukuvirheet
sekä virheen jälkeisen jatkon estäminen. Tarkiste on nimetty testikorvaus:
koe ei todista kryptografiaa, Windows-tiedostorajoja tai fyysisen levyn
virhekäyttäytymistä.

Windowsin erillinen owner-koe läpäisi 22 tapausta. Se käyttää samoja
tuotannon session-funktioita testiapurissa ja varmentaa muun muassa
järjestyksen, muuttuneet tiedosto-/descriptor-sidonnat, virheellisen pysyvän
tilan, leasen todellisen jakamiskiellon ja rajatun odotuksen. Julkaisijan
hallittu katkaisu ja callback-virhe säilyttävät READYn ja julkaistun
descriptorin. Generic consume onnistui julkaisijan pitäessä leasea.
Tämä koe ei käynnistä normaalia broker-/worker-elinkaarta.

Owner-kokeen ensimmäinen ajo säilyy epäonnistuneena: 18 tapausta läpäisi,
kaksi ylitti ulomman aikarajan ja kaksi jäi sen jälkeen estetyiksi.
Alkuperäisten viiveiden syy jäi avoimeksi. Testiin lisättiin rajattu,
monotoninen apuprosessien tapahtumajälki ja alkuperäisen
exitVerified=false-virheen säilyttävä jatkoesto. Seitsemän synteettistä
regressiota kattaa myös myöhäisen virheen ja asynkronisen käynnistyksen
omistajuuden. Korjattu 22 tapauksen ajo onnistui muuttamatta tuotannon
määräaikoja. Uusi onnistuminen ei selitä aiempia viiveitä.

Nykyisen lähteen tuotantobinäärit rakennettiin ja suljettu paketti
tarkistettiin. Desktopin käännös sekä integraatio- ja yksikkötestien
tyyppitarkistukset läpäisivät. Kohdennettu 61 tapauksen sarja sisältää
18 lataajan testiä, 12 session-apurin testiä ja 31 Host-ohjaintestiä.
Lataajan kumulatiivinen prosessinkäynnistyskielto säilyi. Host-testit
korvaavat session- ja worker-portit erikseen; oikeat generic-helperit
todistavat descriptor-polun toimintaa. Nämä testit eivät yksin todista
uutta natiivia session-rajaa. Julkisen Host-reseptin koko 89 tapauksen
valintaa ei ajettu tässä tarkistuksessa.

Tuotantoloaderia käyttävä oikean brokerin koostumiskoe läpäisi 1/1.
Se torjui generic-julkaisun ilman READY-tilaa ja muuttuneen descriptorin
ennen Mainiin liittymistä. Onnistunut tilakierros varmisti
READY/BROKER_ADMITTED-sidonnan sekä Main-STOPin ja brokerin todellisen
exit0:n. Backend oli synteettinen ja saman Node-isännän sisällä;
mallia ei ajettu. Brokerin FILETIME:sta varmennettiin vain ei-nolla,
ja siivousnäyttö koostui brokerin raportista ja paikallisesta jälkitilasta.
Tämä ei ole riippumaton prosessi-/Job-/profiili-/verkkorajan hyväksyntä.

BROKER_ADMITTED-varauksen erillisen vapautuksen omistaa
[liittyneen sessionin natiivivapautus](mcp-clean-release.md). Saman Mainin
uudelleenavaus ja kaatumispalautus puuttuvat edelleen. Session-tietue ei yksin
anna poistovaltuutta; koskaan liittymättömän sessionin pristine-polku kuvataan
seuraavaksi.
Oletuskoostaminen ja koko sovelluksen riippumaton OS/FMI/CPU/GPU-näyttö
eivät tule hyväksytyiksi tällä perustalla.


## Pristine-vapautus ja todennettu näyttö

--release-pristine-polku vapauttaa sinetöidyn READY-sessionin, johon broker
ei ole liittynyt. Se on varmennettu erillisessä Windows-owner-kokeessa ja
Node-isännän koostumiskokeessa. Tämä ei hyväksy uudelleenavausta,
kaatumispalautusta tai Electronin oletuskoostamista.

Kiinteä 1024 tavun native-session-release.bin sidotaan omaan ja alkuperäisen
sessionin tiedostoidentiteettiin, READY-tietueen SHA-256:een, Mainiin,
generationiin, descriptoriin, pakettiin sekä 13 kiinteään poistokohteeseen.
Kahdeksan tiedoston koot ja hashit sidotaan hyväksyttyyn pakettiin.
Intentin flush ja takaisinluku edeltävät ensimmäistä poistoa. Uusinta
hyväksyy vain jo poistetun etuliitteen kiinteässä järjestyksessä, ja varmentaa
koko jäljellä olevan puun. Tiedostot poistetaan ennen niiden tyhjiä hakemistoja.

Poisto kohdistuu säilytettyyn DELETE-kahvaan
[FileDispositionInfo-operaatiolla](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle).
Kahvan sulun jälkeen vaaditaan varma poissaolo; delete-pending tai
epäselvä tiedostokysely ei hyväksy seuraavaa poistoa. Valmis poisto saa
erillisen native-session-released.bin-kuittauksen, joka sidotaan intenttiin.
Molemmat tietueet sekä lease ja alkuperäinen session säilyvät. Minkä tahansa
release-tietueen olemassaolo, myös vioittuneena, estää vanhan sessionin
prepare/seal/publish- ja admission-polut.

Mainin absoluuttinen sulkuaika kulkee sen omissa Node-lataus- ja apuripoluissa
varmistuksesta käynnistykseen ja syötteen lähettämiseen. Sulkuhavainnot
tarvitaan myös silloin, kun myöhäiselle lapselle ei lähetetty valtuutusta.
Natiivilla apurilla on oma viiden sekunnin rajansa; se tarkistaa sen ennen
uusien tietueiden luontia, kirjoitusta, flushia ja poistomerkintää. Jo alkanut
synkroninen Windows-kutsu ei muutu keskeytettäväksi tällä tarkistuksella.

ReleaseRecordIo on vain vapautustietueiden sisäinen riippuvuus: tuotanto
tekee oikeat seek/write/truncate/flush/read-kutsut. Poikkeavat paluuarvot,
lyhyet tavumäärät ja takaisinluvun ero pysäyttävät saman tuotantokoodin.
[Windowsin kirjoitusvälimuisti](https://learn.microsoft.com/en-us/windows/win32/fileio/file-caching)
on syy eksplisiittiseen flushiin; tiedoston sulkua ei pidetä sen korvikkeena.
Testisovitin valitaan vain erillisessä C++-koeajurissa, ei tuotannon
CLI:stä tai ympäristöstä.

Host käyttää natiivista vapautusporttia vasta varmojen apurien, suljetun
kuuntelijan, detach/revoke-polun ja poistetun descriptorin jälkeen.
BROKER_ADMITTED ei kelpaa tähän polkuun. Host säilyy kertakäyttöisenä:
completion ei vielä salli leasen uudelleenkäyttöä tai uutta generationia.

Vapautuscodecin ja etuliitepolitiikan 37 siirrettävää tapausta läpäisi.
Tarkiste on tässä nimetty testikorvaus, ei Windows- tai kryptografianäyttö.
Aikarajakorjausten desktop-käännös, testien tyypit ja 54 synteettistä
sovitintestiä läpäisivät. Tuotannon natiivipaketti rakennettiin ja sen
suljetut lähde-, työkalu-, binääri- ja worker-pinnit tarkistettiin.

Windows-ownerin koko 65 tapauksen ajo läpäisi ilman ohituksia. Se sisältää
aiemmat 22 session-tapausta ja 43 vapautustapausta: tavallisen poiston ja
saman completionin uusinnan, kaikki 14 keskeytysrajaa, 12 tietueen I/O-virhettä,
ristiriitaiset kahvat ja delete-pending-tilanteet, muuttuneet identiteetit,
sisällön, ACL:n ja puun sekä molemmat admission-kilpailujen suunnat.
Testiapuri käyttää tuotannon natiiveja vapautusfunktioita; poikkeava I/O ja
pidetyt kahvat valitaan vain sen sisäisillä testipoluilla.
Pidettyjen esteiden testimoodi käyttää 20 sekunnin rajaa; tavallisen
natiivitoiminnon tuotantoraja on viisi sekuntia. Tämä ei ole koko Windowsin
prosessikäynnistyksen läpimenoaikaraja. Mainin absoluuttinen sulkuraja ja
syötteen lähetysportti ovat siitä erillisiä.
Kaikkien 403 omistetun lapsen todellinen sulkeutuminen havaittiin.
Odotetut virhepoistumiset ja tarkoitukselliset keskeytykset erotetaan
onnistuneista exit0-poistumisista. Tapauskohtainen jäljitys pysyi 512
tapahtuman rajassa ilman ylivuotoa, epävarmuutta tai siivousvirheitä.

Kymmenen synteettistä jäljitystestiä varmentaa myös stdin-havainnon
läpinäkyvyyden ja saman absoluuttisen määräajan välittämisen. Jäljitys ei
lue eikä tallenna stdin-syötteen sisältöä. Jokaisen operaation määräaika on
samalla rajatulla request-tapahtumalla; erillinen tapahtuma jokaista
tiedostokyselyä kohti täytti aiemman jäljen. Ylivuoto hylkää nyt myös
kyseisen testin ja estää seuraavat tapaukset.

Host-ohjaimen 38 tapauksen sarja läpäisi. Session- ja worker-portit ovat
siinä synteettisiä, generic-helperit oikeita. Jos seal palautuu varmasti
onnistuneena kesken avauksen sulun, erillinen cleanup-signaali saa pyytää
pristine-vapautusta. Prepare-vaiheen keskeytys tai epävarma seal-tulos ei
saa tätä oikeutta. Synteettinen release-kuitti ei todista hakemiston poistoa.

Tuotantoloaderin ja nykyisten natiivibinäärien koostumiskoe läpäisi kaksi
tapausta. Ensimmäinen varmentaa oikean broker/worker-tilakierroksen ja
Main-STOPin sekä brokerin todellisen exit0:n; liittynyt varaus säilyy.
Toinen poistaa kehitysyhteyden käytöstä setEnabled(false)-kutsulla ilman
broker-asiakasta. Oikea natiivi CLI poistaa varauksen, mutta säilyttää
alkuperäisen READYn, leasen, intentin ja completionin. Tiedostojen tyypit,
koot, linkkimäärät, identiteetit, checksumit ja kontekstisidonnat tarkistetaan.
Jokainen testin aloitus pitää jatkoeston päällä, kunnes myös kuitti ja
lopulliset assertiot ovat onnistuneet. Molempien backend on synteettinen
ja saman Node-isännän sisällä; kielimallia ei ajettu.

Aiemmat epäonnistumiset säilyvät: ensimmäinen basic-koe pysähtyi identityn
käynnistykseen; ensimmäisen laajan owner-ajon consume-viive esti myöhemmät
tapaukset. Synkronisen käynnistyksen viiveiden käyttöjärjestelmätason syy
jäi avoimeksi. Kokeen puuttuva absoluuttisen aikarajan välitys korjattiin,
ja kohdistettu consume-koe läpäisi ennen laajaa uusintaa.
Seuraavan owner-ajon 52 tapausta olivat täydellisiä; yksi body läpäisi mutta
sen jälki ylivuoti ja 12 jäi estetyksi. Lisäksi Hostin aiempi 37/38-ajo
säilyy epäonnistuneena vanhentuneen seal-odotuksen vuoksi. Korjattu
kohdistettu seal-testi ja koko 38 tapauksen sarja läpäisivät. Onnistuneet
ajot eivät selitä aiempien käynnistysviiveiden syytä.

Koko julkista 97 tapauksen Host-reseptiä ei ajettu tässä tarkistuksessa;
sen prerequisite on hyväksytty nykyiseen lähteeseen sidottu bootstrap-kuitti.
Node-koostumiskoe ei ole Electronin oletusentryn E2E eikä riippumaton
OS-/verkko-/Job-/profiilinäyttö. CLEAN on edelleen brokerin ilmoitus.
Liittyneen sessionin erillisen release-clean-polun sopimuksen ja sen
nykyisen näytön omistaa [natiivi vapautus](mcp-clean-release.md). Saman Mainin
uusi generation, kaatumispalautus sekä koko minimipaketin FMI-/CPU-/GPU- ja
oikeusrajat jäävät jatkotyöksi.
