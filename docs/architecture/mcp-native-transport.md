# MCP-työntekijän kaksikanavainen kuljetus

Tämä dokumentti omistaa eristettyyn Node-prosessiin vietävän MCP-työntekijän
viestimuodon ja stream-koosteen. Toteutettu työntekijä on erillinen ehdokas;
nykyinen `startMcp`-oletusentry ei vaihdu. Natiivi Windows-käynnistäjä,
resurssipaketin oikeudet, mainin todentaminen ja käyttöjärjestelmätason
näyttö ovat vielä jatkotyötä. Koko tavoitteen omistaa
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
suljettu tiedostoluettelo on vielä rakennettava ja tarkistettava.

Kooste, tavallinen Node-prosessi ja latauskoukku eivät toteuta AppContaineria,
LPAC:ia, tiedostojen OS-rajaa tai verkkokieltoa. Mainin autentikointia,
kehityskytkimen koko natiiviketjua, todellista mallia tai FMI-yhteyttä ei
ole tämän osavaiheen perusteella hyväksytty.

Myös vanhan `server.ts`-entryn modernista tunnistuksesta vanhempaan
alustukseen siirtymisen omistajuus jää erilliseksi regressio-/siirtotyöksi.
Ehdokkaan korjausta ei esitetä vanhan oletusentryn korjauksena.
