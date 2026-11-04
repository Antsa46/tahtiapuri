# Mallien ajotavat ja toimitettava runtime

Tila: toteutussuunta hyväksytty 4.11.2026. Tämä dokumentti omistaa
malli- ja ajotapavalinnan erottelun sekä niiden toteutusjärjestyksen.
Mallikirjaston ja profiilien sopimuksen omistaa
[paikallisen mallin suunnitelma](local-model-plan.md).
Oikeusmatriisin ja luottamusrajat omistaa
[turvallisuussuunnitelma](security-and-permissions-plan.md).
Issue #10 pysyy avoimena, kunnes sen ajonaikainen näyttö on olemassa.

## Sovitut valinnat

Malliprofiili (esimerkiksi hyväksytty 4B tai 8B), laskentatausta ja
käyttöjärjestelmän oikeusprofiili ovat eri asioita. Asetusten tavoite on:

| Ajotapa | Tarkoitus | Hyväksymisehto |
| --- | --- | --- |
| Eristetty CPU | Ensimmäinen toimitettava perusta ilman GPU-vaatimusta. | Rajattu malliprosessi, tiedosto- ja verkkokiellot sekä oikea vastaus, peruutus ja sulku. |
| Eristetty CUDA | GPU-kiihdytys samoilla tiedon ja verkon rajoilla. | Oma näyttö täsmällisestä moottori-, CUDA- ja käyttöjärjestelmäkokoonpanosta. |
| Tavallinen CPU | Käyttäjän erikseen valitsema vaihtoehto. | Näkyvä tieto Windows-eristyksen puuttumisesta ja toimiva elinkaari. |
| Tavallinen CUDA | Käyttäjän erikseen valitsema GPU-vaihtoehto. | Sama tieto eristyksen puuttumisesta sekä todellinen GPU-ajo. |

Käyttäjä hyväksyi tavallisissa ajotavoissa myös Tähtiapurin omien
keskustelujen ja havaintopaikkojen käyttämisen, kun hän valitsee ajotavan
itse. Tämä ei anna mallille uusia sovellustyökaluja, suoraa historiarajapintaa
tai asetusten muutosoikeutta. Mallille välitettävän kontekstin rajaus säilyy.
Tavallinen prosessi toimii kuitenkin käyttäjän OS-oikeuksilla:
sovelluksen rajapinnat eivät estä kaapattua natiiviprosessia käyttämästä
käyttäjän muita tiedostoja tai verkkoa. Sitä ei merkitä eristetyksi.

Eristys-, lataus-, muisti- tai CUDA-virhe ei vaihda tavalliseen ajotapaan.
Puuttuva runtime estää malliajon, mutta kartta voi jatkaa toimintaansa.
Eristetty CUDA pysyy kokeella ratkaistavana; tavallinen CUDA ei täytä
sen hyväksymisehtoa.

## Valinnan omistaja ja vaihtuminen

Luotettu main omistaa hyväksyttyjen malliprofiilien ja toteutettujen
ajotapojen suljetun luettelon. UI käyttää nimettyä asetuskutsua; raaka polku,
komento tai asiakkaan ilmoittama oikeusprofiili ei kelpaa käynnistysluvaksi.
Malli, mallivastaus, backendin mallityö ja MCP eivät muuta ajotapaa.

Ensimmäisen asetustoteutuksen valinta tulee voimaan seuraavassa
sovelluskäynnistyksessä. UI näyttää aktiivisen ja seuraavaksi tallennetun
valinnan erikseen. Puuttuva tai virheellinen asetus ei aktivoi tavallista
ajoa. Tiedostopolun ja mallivalinnan tallennuksen tarkka sopimus sekä
puuttuvan painon käsittely kuuluvat T14:ään ennen sen toteutusta.

Nykyinen submit/probe sisältää cpu/cuda-kentän. Kun mainin ajotapavalinta
otetaan käyttöön, kenttä poistetaan tai siitä tulee vaatimus, jonka on
vastattava aktiivista valintaa. Se ei saa valita eristysprofiilia.
Nykyisen sovelluksen pyyntökohtainen CPU/CUDA-valinta ei vielä toteuta
tätä uutta asetussopimusta.

Välitön vaihto ilman uudelleenkäynnistystä on erillinen myöhempi työ:
uudet UI/MCP-työt estetään, vanhat työt perutaan, omistettujen prosessien
poistuminen varmistetaan ja vasta sitten aktivoidaan uusi istunto.
Jonossa olevaa työtä ei siirretä toiselle oikeusprofiilille.

## Yhteinen sopimus ja sovittimet

Backendin käyttötapaukset riippuvat mallityön portista. Mainin käynnistäjä
valitsee sallitun runtime-sovittimen. Malliprosessi vastaanottaa rajatut
initialize/run/cancel/ping/shutdown-viestit, mutta ei valitse omia oikeuksiaan.
Käynnistäjä todentaa OS-profiilin erikseen; työntekijän ready tai oma
ilmoitus eristyksestä ei ole oikeusnäyttö.

Node-pohjaisen työntekijän elinkaari erotetaan Electron-entrypointista.
Ydin ei importoi Electronia tai natiivikirjastoa. Samat protokollan ja
elinkaaren hyväksymistapaukset kohdistetaan myös mahdolliseen natiiviseen
työntekijään; C++-toteutus ei automaattisesti käytä TypeScript-ydintä.

Sulku peruu työn ja odottaa natiivioperaation päättymisen ennen disposea.
Omistajan aikaraja ja pakotettu prosessisulku rajaavat jumittuneen operaation.
Odottamaton generoinnin tai kontekstin vapautuksen promise-hylkäys lopettaa
työntekijän; epävarmassa tilassa olevaa moottoria ei käytetä uudelleen.
Vain nykyinen lapsi ja istunto saavat muuttaa mainin tilaa.
Nykyisen SDK-sovittimen mallin laskentasäikeiden raja on enintään kuusi ja enintään
prosessille saatavilla oleva rinnakkaisuus (`os.availableParallelism()`).
Näin yhden suorittimen koerajaus huomioidaan myös SDK:n kontekstin
laskennassa. Asetus ei rajoita kaikkia Node- tai kirjaston apusäikeitä,
eikä se ole lämpötila- tai kokonaismuistiraja.

## Toimitusruntimen ratkaiseminen

Omaa korjattua Node-haaraa ei valita ylläpidettäväksi tuotteen riippuvuudeksi.
Aiempi Node-/SDK-koe säilyy tutkimusnäyttönä.
Vaihtoehdot ovat virallinen yhteensopiva Node-runtime tai pieni
natiivinen llama.cpp-työntekijä. Uusi binääri, sen alkuperä, versio, lisenssi
ja käynnistysketju lukitaan ennen natiivin toteutuksen käyttöönottoa.

Tarkistus 4.11.2026: [virallisen Node-jakelun luettelo](https://nodejs.org/dist/index.json)
ilmoittaa nykyisille v24/v26-julkaisuille libuv 1.52.1:n.
[Upstream-issue](https://github.com/nodejs/node/issues/66374)
kuvaa AppContainerin lapsiprosessiputkien ongelman ja libuv 1.53.0:n korjauksen.
Päivityksen saatavuus tarkistetaan uudelleen runtime-valinnassa.
Tämä ei yksin todista uuden runtimen LPAC-, IPC- tai SDK-yhteensopivuutta.

Natiivityöntekijän viestikanava erotetaan natiivikirjaston lokitulosteista.
Kanavan tunnistus, sanomakoon rajat, katkennut yhteys, käynnistysvirhe ja
koko omistetun prosessipuun sulku testataan ennen mallipainojen lataamista.
[Natiivin viestintäkokeen](../experiments/native-transport-probe.md) koebinäärit
erottavat tämän kuljetusnäytön malliruntimen ja koko sovelluksen hyväksynnästä.

[Natiivin CPU-mallin koe](../experiments/native-cpu-model-probe.md) käyttää
lukittuun, muuttamattomaan llama.cpp-lähderevisioon perustuvaa omaa
CPU-rakennusta ja yhteistä natiivia käynnistintä. Virallinen b12110-binääri
säilyy aiempana verrokkina.
Se ei vielä vaihda sovelluksen ajotapaa tai hyväksy koko oikeusrajaa.

## Toteutusjärjestys ja näyttö

1. Yhteinen viesti- ja elinkaarisopimus sekä nykyisen työntekijän sulkuvirheet.
2. Toimitettavan CPU-runtimen rajattu viestintäkoe eristyksessä ilman mallia.
3. Oikea pieni CPU-malliajo, rajatut tiedostot, verkkokiellot ja virhe-/sulkutapaukset.
4. Mainin ajotapavalinta ja backendin/MCP:n vastaavat oikeusrajat.
5. Eristetty CUDA ja erikseen valittavat tavalliset ajotavat; sama hyväksymismatriisi.
6. T14:n mallikirjasto ja asetukset, varhainen kokonaispaketti ja lopullisen asentimen uusintanäyttö.

Työvaiheet voivat tuottaa osatuloksia. Yksikkötesti, ordinary-ajon toimivuus
tai erillinen LPAC-koe ei sulje koko #10:tä.
FMI:n täsmällinen ulospääsy, backendin ja MCP:n rajat sekä GPU:n näyttö
säilyvät avoimina, kunnes ne on kokeessa osoitettu.
