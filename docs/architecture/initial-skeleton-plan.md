# Ensimmäinen runko ja kevyt paikallinen backend

Tämä on toteutusvaiheen ehdotus. Päätösten tilan kokoaa
[päätöshakemisto](../planning/decisions.md). Käyttäjä on valtuuttanut toteutuksen
aloittamisen issue kerrallaan; ensimmäisen kokeen lähtötiedot ovat
[kokeen kuvauksessa](../experiments/model-pilot.md). T02:n statusrunko on toteutettu;
T03 lisäsi ensimmäisen 4B-mallitoiminnon. Havaintotoiminnot tulevat myöhemmin.
Sovellusjaon omistaa [perusarkkitehtuuri](base-architecture.md);
oikeusrajat ja eristyksen käyttöönoton ehdot
[turvallisuussuunnitelma](security-and-permissions-plan.md).

## Miksi backend jo ensimmäiseen runkoon

Suositus on pieni paikallinen Node/TypeScript-backend Electronin hallitsemana.
Sama rajapinta palvelee käyttöliittymää ja rajattuja agenttityökaluja.
Backend omistaa syötteen tarkistuksen, käyttötapaukset, työkalupolitiikan,
mallitehtävien koordinoinnin ja myöhemmin tallennuksen.

Tuleva sää-API kulkee backendin sääportin kautta eristetylle säätyöntekijälle.
Käyttöliittymä ja kielimalli eivät tee ulkoisia kutsuja itse.
Aluksi portti voi palauttaa synteettisen ennusteen tai tiedon sen puuttumisesta.

Electron-mainiin jäävät ikkunat, valvottu välitys ja prosessien elinkaari.
Node/TypeScript-runtime toimitetaan desktopin mukana; erillinen käyttäjän
Node-, Python- tai palvelinasennus ei ole tavoite. Electronin hallittu
utilityProcess on backendin ajotapaehdokas, ei turvallisuushiekkalaatikko.

Sisääntulon kuljetussovitin on ohut IPC-adapteri. Käyttäjän valinnan ja
[vertailun](base-architecture.md#paikallinen-http-vai-suora-prosessikanava)
omistaa perusarkkitehtuuri. Tähän backend-yhteyteen ei lisätä HTTP-palvelinta
tai HTTP-frameworkia. Viestisopimuksen ja kanavan oikeusrajat todennetaan.

## Ehdotettu etenemisjärjestys

Koko projektin vaiheet, riippuvuudet ja työpaketit omistaa nyt
[roadmap](../planning/roadmap.md). Ensimmäinen tekninen tavoite on P1:
pieni desktop/IPC-runko ja oikea 4B/8B-mallikoe synteettisellä aineistolla.
Varsinainen tähtilaskenta, kartta, sää ja tietojen säilytys yhdistetään
roadmapin myöhemmissä työpaketeissa.

Tämä dokumentti omistaa rungon tekniset vastuut. Se ei ylläpidä toista
työjonoa tai samaa vaiheistusta erillisenä taulukkona.

## Rungon rakentamisen periaatteet

- Lähdekoodin kieli on TypeScript; mallin natiivimoottori voi käyttää
  muuta tekniikkaa sovittimen takana. Python-palvelinta ei tarvita oletuksena.
- Vain tarpeelliset sovellukset ja paketit luodaan. Yksi käyttötapaus
  kulkee valittujen kerrosten läpi ennen uusien ominaisuuksien aloittamista.
- Pakettien rakennus seuraa riippuvuuksia: puhdas domain ja rajapinnat ennen
  niiden kuluttajia. Ulkoisia kirjastoja ei niputeta domainin vastuuksi.
- Monorepon paketinhallinta, testityökalut, versiot ja komennot sovitaan
  ennen käyttöönottoa. Muiden projektien komentoja tai asetuksia ei kopioida sokkona.
- Kehitys-, testi- ja käyttäjädata pidetään erillään. Testit käyttävät omaa
  tilapäistä datajuurta; testikomentoja ei lisätä tuotannon rajapintaan.
- Rakennus ei lataa mallia tai lähetä sijaintia sivuvaikutuksena.
  Paketoinnin resurssit määritellään sallittujen tiedostojen listana.

Tarkistukset perustuvat [testausohjeeseen](../ai/testing-rules.md).
Todelliset typecheck-, build- ja testikomennot ovat
[paikallisessa kehitysohjeessa](../development/local-development.md).
Dokumenttiin kirjoitettu esimerkkipolku tai tuleva tarkistus ei ole ajettu koe.

## T02:n toteutettu runko

Ensimmäinen ajettava runko käyttää valittua apps/- ja packages/-jakoa:
React-näkymä → rajattu preload → main → UtilityProcess-backend.
Status ei tarvitse havaintopaikkaa, sääyhteyttä, tietokantaa tai kielimallia.
Backendin runtime-status on kuljetuksesta riippumaton sovelluskäyttötapaus.
Astronomian domain-paketti lisätään vasta, kun sillä on oikeita sääntöjä;
sitä ei ole luotu täytteeksi eikä siihen kytketä Electronia.

### IPC-sopimus

- T02:n statuskomento on argumentiton window.tahtiapuri.getStatus().
  Main tarkistaa omistetun WebContentsin, pääkehyksen, tarkan
  tahtiapuri://app/index.html-osoitteen ja argumenttien puuttumisen.
- Main ja backend käyttävät yksityistä utilityProcess/parentPort-kanavaa.
  Mainin satunnainen 256-bittinen istuntoavain välitetään alustusviestissä;
  sitä ei anneta rendererille, komentoriville, käyttöympäristölle tai lokeihin.
- Alustus ja valmius käyttävät protokollaversiota 1.
  Pyyntö sisältää tyypin, version, istunnon, UUID-tunnisteen,
  nimetyn operaation ja päättymisajan. Tuntemattomat kentät hylätään.
- Operaatiot ovat runtime.status, runtime.ping ja runtime.shutdown.
  Pyynnön määräaika on enintään 5 sekunnin päässä; main käyttää 2,5 sekuntia.
  Väärä istunto, vanha määräaika, tuntematon operaatio ja toistettu tunniste hylätään.
- Main hyväksyy vain oikeaan istuntoon, vireillä olevaan tunnisteeseen
  ja operaatioon kuuluvan tarkistetun vastauksen.
  UI saa vain julkisen statusvastauksen tai UNAVAILABLE-koodin.
- Vireillä on enintään 14 sovelluspyyntöä; heartbeatille ja sululle jää kapasiteetti.
  Heartbeat lähetetään 2 sekunnin välein, yksi kerrallaan.
  Kapasiteettipaine ei itsessään tarkoita backendin kuolemaa.
- Backendin 256 viimeisimmän tunnisteen joukko on rajattu.
  Se ei tarjoa yleistä tiedosto-, URL-, shell- tai viestinvälitystyökalua.

Viestien runtime-validaattorit ovat packages/validation/src/-puussa;
UI-asiakas käyttää vain julkista sopimusta. Käyttötapaus ja IPC-adapteri
ovat backendissä, prosessin omistajuus desktop-mainissa.

### Käynnistys, sulku ja käyttöliittymän rajat

Backendin valmiudelle ja ensimmäiselle onnistuneelle UI-statuskierrokselle
on kummallekin 5 sekunnin aikaraja. Puuttuvat preload/index-resurssit
havaitaan ennen backendin käynnistystä. UI:n valmius vaatii saman
lähettäjä- ja vastaustarkistuksen kuin myöhemmät pyynnöt.

Sulku estää uudet kutsut, hylkää vireillä olevat pyynnöt ja lähettää
omistetulle backendille sulkukäskyn. Main odottaa rajatusti ja tarvittaessa
päättää juuri omistamansa UtilityProcessin; poistuminen varmistetaan.
Backendin, rendererin tai käynnistyksen virhe sulkee tämän ensimmäisen
rungon. Mallin kaatuminen käsitellään erikseen T03:ssa: UI ja backend jatkavat.
Backendillä on lisäksi 10 sekunnin parent-heartbeat-vahti.
Tämän toimivuus paketoidussa ohjelmassa varmistetaan toimituskokeessa.

Renderer käyttää sandboxia ja context isolationia, ilman Node-integraatiota.
Paikallinen protokollakäsittelijä palvelee vain indexin ja hyväksytyt JS/CSS-resurssit.
CSP ja oman session pyyntösuodatin rajaavat rendererin verkkopyynnöt;
navigointi, uudet ikkunat, webviewt ja laiteoikeudet on estetty.
Backendille välitetään erikseen sallittu pieni Windows-ympäristö,
ei kehittäjän tunnuksia tai Node-käynnistysasetuksia.
Nämä sovellusrajat eivät toteuta T09:n OS-eristystä.

Ajo- ja tarkistuskomennot omistaa [paikallinen kehitysohje](../development/local-development.md).
Tämän työpaketin tarkistusten tulokset ja hyväksyntä säilyvät
issue #3:ssa.

## T03:n mallitoiminnon lisäys

Preload tarjoaa lisäksi nimetyt assistant.submit/get/cancel-kutsut.
Ne käyttävät samoja mainin lähettäjä- ja argumenttitarkistuksia kuin status.
Backendin assistant-moduuli omistaa rajatun työjonon; main välittää sen
hyväksytyt mallityöt erilliseen UtilityProcessiin yksityisellä kanavalla.
Main ei importoi mallimoottoria tai tee inferenssiä itse.

Mallin lataus on laiska: ensimmäinen kysymys käynnistää valitun CPU-/CUDA-taustan.
Main pysäyttää mallityöntekijän sovelluksen mukana. Tarkat mallirajat omistaa
[mallisuunnitelma](local-model-plan.md#t03n-toteutettu-malliraja), ajon näytön
[moottorikoe](../experiments/model-runtime-probe.md).

## Ennen verkkokokeilua ratkaistavat asiat

Sääpalveluksi on valittu Ilmatieteen laitoksen avoin data. Varmennetaan
rajattu ennustekysely sekä valitaan kohdealustan verkko- ja tiedostorajaus.
Säätyöntekijä tarvitsee rajatun HTTPS-yhteyden. Backendin ja mallimoottorin
ulospääsy estetään erikseen; niiden paikallinen viestintä sallitaan vain tarpeen mukaan.

Rajoituksen pitää toimia myös paketoidussa sovelluksessa ja mallimoottorin
käyttämällä CPU/GPU-polulla. Jos eristystä ei vielä pystytä todentamaan,
kokeilu jatkuu offline-aineistolla. Virtuaalikone voidaan myöhemmin arvioida
eristyskokeeksi, mutta se ei ole loppukäyttäjän asennuksen oletusvaatimus.
