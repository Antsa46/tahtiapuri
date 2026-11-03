# Testien sijainti ja arviointiperiaatteet

Tämä dokumentti omistaa testien sijainnin ja tasojen jaon.
Käyttäjä pyysi 3.11.2026 yhteistä sijoitteluperiaatetta EKYn kanssa:
lähteen lähellä olevat testit ja erikseen keskitetyt laajat testit.
Tämä korvaa aiemman kaikkien testien tests/-varjorakenteen.
Käyttäjä jätti sijoittelun ja ylläpidon Codexin harkintaan. Nykyinen
yhdistelmä säilyy; sijoittelua muutetaan vain todellisen ylläpitohyödyn
perusteella ja ohje päivitetään samalla.
Ensimmäisen kokeen testityökalun versio on valittu
[kokeen lähtötiedoissa](../experiments/model-pilot.md). T02:ssa on otettu käyttöön
Vitest ja Playwright; todelliset ajokomennot ja raporttipolut ovat
[paikallisessa kehitysohjeessa](../development/local-development.md).
Lähderakenteen omistaa [perusarkkitehtuuri](../architecture/base-architecture.md).
Alla olevat polut kuvaavat tulevaa rakennetta, eivät olemassa olevaa koodia.

## Paikallinen käyttö ja testien ajaminen

Käyttäjän linjaus: ohjelmaa käytetään omalla koneella ja testit ajetaan
paikallisesti. Ilmaisu ei git-testausta tulkitaan GitHub-/etä-CI-ajojen
poisrajaamiseksi; tähän ei rakenneta workflowita, pilvitestipalvelua,
PR-portteja tai julkaisuputkea. Paikallinen Git-versionhallinta on tästä
erillinen kysymys, eikä sen käyttöönottoa tai poistamista päätetä tässä.
Testien paikallinen ajotapa ei poista todellisen mallin, prosessien tai
verkkorajausten testaamista silloin, kun kyseinen toiminto toteutetaan.

## Testit lähteen vieressä ja yhteinen testipuu

- Yksikkö- ja komponenttitestit ovat testattavan tiedoston vieressä.
- Yhden moduulin integraatiotesti on omistavassa lähdealueessa ja käyttää
  .integration.test.*-nimeä. Usean moduulin yhteistoiminta kuuluu tests/integration/-puuhun.
- Kaikki E2E-testit ja niiden käynnistysapu ovat tests/e2e/-puussa.
  Malliarvioinnit, yhteiset fixturet, mockit ja testiapurit ovat erikseen
  tests/evaluations/-, tests/fixtures/- ja tests/support/-puissa.

```text
packages/domain/src/planning/visibility.ts
packages/domain/src/planning/visibility.test.ts

apps/web/src/features/sky-map/SkyMap.tsx
apps/web/src/features/sky-map/SkyMap.test.tsx

apps/backend/src/modules/planning/application/create-observation-plan.ts
apps/backend/src/modules/planning/application/create-observation-plan.integration.test.ts

tests/integration/assistant/briefing.integration.test.ts
tests/e2e/desktop/observation-plan.spec.ts
tests/evaluations/assistant/observation-plan.cases.json
tests/fixtures/
tests/support/
```

E2E kuvaa käyttäjäpolkua, ei yksittäisen lähdetiedoston varjopolkua.
Lähteen mukana siirtyy sen vieressä oleva testi. Testiperheiden hakukuviot
erotetaan niin, ettei sama tiedosto ajaudu vahingossa useaan ajoperheeseen.
Malliarviointi ei ole E2E-testin synonyymi.

Valinnan peruste on vastuun läheisyys ja yhtenäisyys EKYn kanssa.
Sitä ei esitetä yleisesti parhaana AI-kehityksen sijoitteluna:
[Vitestin ohje](https://main.vitest.dev/guide/learn/writing-tests#test-files)
kuvaa sekä lähteen vieressä että omassa hakemistossa olevat testit hyväksyttäviksi.

Tuotantokoodi ei importoi testejä tai tests/-puuta. Testit, testiapurit ja
aineistot rajataan tuotannon käännöksestä sekä toimituspaketista.
Testiapurit eivät avaa testikomentoja tuotannon IPC-rajapintaan.
Generoidut raportit ja ajotulokset keskitetään .artifacts/tests/-puuhun,
reportterien lähdekoodi tests/support/-puuhun. Juureen ei luoda erillisiä
test-reporters- tai raporttikansioita. Näitä hakemistoja ei luoda suunnittelussa.

## Testitasot

| Perhe | Mitä todennetaan |
| --- | --- |
| unit / component | Puhtaat havaintosäännöt, muunnokset, validointi ja UI:n kohdistettu käyttäytyminen; testit lähteen vieressä. |
| integration | Käyttötapaus porttien ja sovittimien läpi; backendin IPC-sopimus ja käyttöoikeusraja, laskentasovitin, säävastauksen tulkinta ja mallivastauksen tarkistus. |
| e2e | Rajatut Electronin käyttäjäpolut, IPC, virhetilat, peruutus ja prosessien hallittu sulkeminen. |
| evaluations | Oikeiden paikallisten mallien laatu, faktatuki, ohjeiden noudattaminen, viive ja muistinkulutus. |
| fixtures / support | Synteettiset aineistot ja testiperheiden yhteiset, rajatut apuvälineet. |

Paketoidun sovelluksen käynnistys-, sammutus- ja uudelleenkäynnistyskoe
suunnitellaan erilliseksi toimituksen tarkistukseksi. Se ei korvaudu
lähdekoodin E2E-ajolla eikä vaadi tuotannon suojausten löysentämistä.

## Ensimmäinen tekninen hyväksymiskoe

Käyttäjä valitsi 3.11.2026 rajatun mallikokeen ennen koko käyttöliittymän
viimeistelyä. Ensimmäinen pari on 4B- ja 8B-kokoluokka.
[Lukitut kokeen lähtötiedot](../experiments/model-pilot.md) omistavat
paketit, synteettiset tapaukset, oikeusprofiilin ja tulosten kirjaustavan.

Koe käyttää sovelluksen omaa mallisovitinta, jonoa ja rajattuja
vastaussopimuksia. Sama vakioitu havaintopaikka, aika, taivastiedot ja
sääfixture annetaan kummallekin mallille. Oikeaa sää-APIa tai käyttäjän
keskusteluja ei tarvita. Tuotannon kartan ja käyttöliittymän viimeistely
ei ole tämän teknisen kokeen edellytys.

Ensimmäisen toimivan mallipolun hyväksymisehdot:

- Malli kertoo annetusta aineistosta suomenkielisen katsauksen ja vastaa
  jatkokysymykseen. Kohde, aika, suunta ja sää eivät muutu keksityiksi faktoiksi.
  Puuttuva tieto ilmaistaan.
- Sovittu määrämuotoinen vastaus tai työkalupyyntö on tarkistettavissa.
  Työkalun nimi ja argumenttien merkitys ovat oikein; backend hylkää
  luvattoman tai virheellisen pyynnön. Tarkat koetapaukset määritellään erikseen.
- Mallin vaihto, oman työn peruutus, latausvirhe ja moottorin kaatuminen
  käsitellään hallitusti. Sovelluksen sulku ei jätä sen omia prosesseja.
- Rajatun MCP-kokeen yhteys, koepyyntö, peruutus ja sulkeminen todennetaan
  sovitun kehitysyhteyden kautta; suljettua yhteyttä ei ohiteta testiajurilla.
- Molempien mallien asetukset, tulokset ja toistetut viive- sekä RAM-/VRAM-
  mittaukset kirjataan. Toimiva ja hylätty tapaus sekä ajamaton tarkistus
  erotetaan raportissa. Mallin sopivuutta tai nopeutta ei oleteta.

Suorituskyvyn tavoiterajat ovat avoimia, kunnes niistä sovitaan; pelkkä
mittaustulos ei ole hyväksyntä tuotantokäyttöön. Koe ei korvaa varsinaisen
käynnistyspolun E2E:tä, paketointikoetta tai OS-eristyksen näyttöä.
Muiden testitasojen jako ja koko havaintopolun riskit säilyvät alla.

## Ensimmäisen havaintopolun tärkeät tapaukset

- Tavallinen havaintoilta ja vain osa aikavälistä sopiva kohde.
- Kohde horisontin tai määritellyn esteen takana.
- Kohde nousee tai laskee kesken aikavälin.
- Riittävä pimeys puuttuu; korkean leveysasteen yö ei ole aina pimeä.
- Paikallinen keskiyö, aikavyöhyke ja kesäajan vaihtuminen.
- Sää puuttuu, on vanhentunut, virheellinen tai saapuu aikakatkaisun jälkeen.
- Tuntematon välineen ominaisuus ei muutu keksityksi tarkaksi arvoksi.
- Malli keksii kohdetunnisteen, väärän ajan tai aineiston vastaisen väitteen.
- Malli tai muistiinpanoteksti yrittää ohjata luvattomaan työkalukutsuun.
- Avustajan tai kehitysportin pyyntö ei muuta asetuksia tai tallennettuja
  havaintopaikkoja eikä poista historiaa; mallin väite käyttäjän hyväksynnästä
  ei kelpaa oikeudeksi. Hyväksytty käyttöliittymäpolku toimii edelleen
  [pysyvien muutosten sopimuksen](../architecture/security-and-permissions-plan.md#avustajan-käynnistämät-pysyvät-muutokset) mukaisesti.
- API- ja IPC-pyyntö sisältää ylimääräisiä kenttiä, väärän tyypin tai liian
  suuren aineiston. Ulkoiset URL:t ja verkkokuvien lataus estyvät.
- Väärä, puuttuva tai edellisen käynnistyksen istunto ei kelpaa backendille.
  Session salaisuus ei tule rendereriin tai lokeihin.
- Mallin tai backendin käynnistys epäonnistuu, työ perutaan tai sovellus
  suljetaan kesken ajon. Uusi käynnistys onnistuu ilman orpoprosesseja.
- Säätyöntekijä ei hyväksy muuta tarjoajaa, vapaata URL:ia tai ylimääräistä dataa.
- [Mallin kehitysyhteys](../architecture/local-model-plan.md#kehitys--ja-diagnostiikkarajapinta-paikalliseen-malliin)
  on oletuksena suljettu. Luvaton asiakas, vanha istunto ja tuntematon operaatio
  hylätään; sulkeminen ja uudelleenkäynnistys mitätöivät yhteyden oikeuden.
  Oikean stdio-MCP-asiakkaan kanssa kokeillaan työkalujen listaus, koepyyntö,
  peruutus ja sulkeminen. Pelkkä suora funktiokutsu ei todista MCP-yhteyttä.
- Asetusten kehitysyhteyskytkin estää uudet kutsut ennen kanavan sulkemista,
  mitätöi vanhat oikeudet, peruu jonossa ja ajossa olevat MCP-työt ja estää
  myöhäisten tulosten palautumisen. UI:n työt jatkavat toimintaansa.
  Uudelleenavaus ei hyväksy vanhaa oikeutta. Codexin enabled-asetus ei
  ohita sovelluksen pois-kytkintä. Uusi sovelluskäynnistys alkaa suljettuna.
- Sovellus sulkeutuu myös avoimen MCP-yhteyden ja kesken olevan malliajon
  aikana. Kehitysyhteys mitätöityy; MCP:n irtoaminen peruu vain sen omat työt.
  UI- ja MCP-pyynnöt käyttävät samaa mallijonoa myös samanaikaisessa kokeessa.
- Mainin tai backendin pakotettu päättyminen, osittain epäonnistunut käynnistys
  ja uusi käynnistys eivät jätä mallia tai säätyöntekijää orpoprosessiksi.
  Tarkistus koskee omistettuja prosesseja; muiden sovellusten prosesseihin
  ei kosketa. Moottorin kaatuminen ei estä karttaa tai laskentakortteja.
- Kehityskokeen koko-, aika- ja jonorajat sekä oman pyynnön peruutus toimivat.
  Mallin työkalupyyntö ei tee sää-, tiedosto- tai käyttöliittymätoimintoa.
  Tuloste tai loki ei sisällä automaattisesti käyttäjäaineistoa tai salaisuuksia.

Laskennan vertailuaineisto sidotaan tunnettuun lähteeseen, versioon ja
toleranssiin. Pelkkä saman laskentafunktion kutsuminen testissä ei ole
riippumaton oikeellisuuden todiste. Käytännön havaittavuutta ei sekoiteta
pelkkään geometriaan.

Tallennusmuutoksen hyväksymisehdot johdetaan
[tiedon elinkaaren sopimuksesta](../architecture/data-lifecycle-plan.md).
Säilyminen, historian rajattu käyttö, poistamisen vaikutus mallikontekstiin
ja keskeytyksestä palautuminen todennetaan synteettisellä aineistolla.

Mallinvaihdon toteutuessa varmennetaan erikseen:

- Vaihto ei jätä kahta malliprosessia tai vanhan mallin tehtäviä käyntiin.
  Myöhästynyt tulos ei näy uuden mallin vastauksena.
- Keskustelun rajattu tekstikonteksti voidaan koota uudelle mallille,
  mutta toisen mallin tai MCP-kokeen laskentakontekstia ei käytetä uudelleen.
- Latausvirhe näkyy, kartta ja laskenta toimivat eikä synny mallilatausta
  verkosta. Avustaja tai MCP ei voi muuttaa asetusten mallivalintaa.

Ulkoisen mallikansion toteutuessa varmennetaan, että uusi tiedosto on
vain ehdokas ja tuettu malli voidaan lisätä ilman sovelluksen buildia.
Vioittunut, yhteensopimaton, poistettu tai tarkistuksen jälkeen vaihdettu
tiedosto käsitellään hallitusti. Malliprosessin luku- ja kirjoitusrajat
sekä linkkien ja verkkopolkujen esto testataan todellisella eristyksellä.

## Toistettavuus ja ajamisen rajaus

Tavalliset automaattitestit toimivat ilman internetiä tai ladattua
kielimallia. Aika, paikat, sää ja mallivastaukset ovat vakioituja fixtureita;
kellon nykyhetkeen tai oikeaan käyttäjäprofiiliin ei nojata.

Oikean sääpalvelun ja kielimallin kokeet käynnistetään erikseen. Niistä
kirjataan aineisto, moottori- ja malliversio, kvantisointi, kontekstikoko,
ajat ja tulokset. Yhden mallin ja usean roolin hyötyä verrataan samalla
aineistolla. Skeeman tai lähdetunnisteen läpäisy ei yksin todista vastauksen
semanttista oikeellisuutta.

Mallivertailussa erotetaan kaksi kysymystä:

- Mallikoko: Qwen3 4B/8B/14B samalla kvantisointiperiaatteella ja samoilla
  tehtävillä, kun resurssit riittävät. Käyttäjän vahvistama aloitus on
  4B ja 8B. Poro ja Ministral ovat erillisiä malliperheverrokkeja.
- Kvantisointi: sama 14B-lähtömalli Q4_K_M- ja IQ3_M- tai Q3_K_M-muodossa.
  Lähtörevision ja muunnosputken tulee vastata toisiaan mahdollisuuksien
  mukaan. 14B IQ3 vastaan 8B Q4 on käytännön pakettivertailu, jossa sekä
  koko että tarkkuus muuttuvat.

Käytetään yhteistä pientä suomenkielistä aineistoa: laskettujen taivastietojen
ja sääfixturen tulkinta, työkalun ja argumenttien valinta, puuttuva tieto
sekä vapaa tähtitieteen selitys. JSON-muoto, argumenttien oikeellisuus ja
vastauksen faktat pisteytetään erikseen. Skeemarajoitettu generointi ja
mallin oma työkalukutsutila kirjataan erillisiksi ajotavoiksi, jos molempia
kokeillaan. Chat-template, thinking-asetus ja muut generointiasetukset
sidotaan tulokseen.

Mitataan kylmä lataus, lämpimän ajon ensimmäisen vastauksen viive,
kokonaisviive, RAM-/VRAM-huippu ja käytetty CPU/GPU-jako. Ajot toistetaan;
yksi nopea vastaus ei osoita mallin paremmuutta. EKYn valinta vaatii sen
omat tehtävät ja kohdekoneet, vaikka 4B toimisi hyvin Tähtiapurissa.

Prosessikokeessa erotetaan toimintakyky ja oikeuksien rajaus.
Varmennetaan todellinen CPU/GPU-ajotapa, kaatuneen lapsen käsittely,
OOM-virhe, peruutus, toistuva mallinvaihto ja sulku. VRAM:n palautuminen
mitataan; sitä ei luvata täydelliseksi tai välittömäksi. CPU-varatilaan
siirtyminen näkyy, eikä käytetyn GPU-taustan toteaminen perustu pelkkään
tiedostonimeen. Koeympäristö ja oikeudet sovitaan ennen mahdollista ajoa
ilman varsinaista sandboxia. Tällainen tulos ei hyväksy verkkokieltoa.

Ennen offline- tai verkkorajauksen valmiiksi toteamista testataan
[turvallisuussuunnitelman oikeudet](../architecture/security-and-permissions-plan.md)
todellisilla eristetyillä prosesseilla. Pelkkä mockin ohittama verkkokutsu,
CSP tai funktiotesti ei todista eristystä. Kokeissa varmistetaan:

- Säätyöntekijän sallittu FMI-pyyntö toimii ja sen muut verkkokohteet
  estyvät. Muiden roolien ulospääsy estyy myös suoralla IP-osoitteella,
  IPv6:lla, DNS:llä ja välityspalvelimen
  tai paikallisen palvelun kautta. Testataan myös luvattomat LAN-yhteydet.
  Sallitun paikallisen mallikanavan poikkeus ei avaa yleistä loopback-pääsyä.
- Säätyöntekijän lupa ei avaudu backendille tai Electronin muille
  apuprosesseille. Rajat säilyvät lapsiprosessissa, kaatumisessa,
  uudelleenkäynnistyksessä ja paketoidun sovelluksen CPU/GPU-ajossa.
- Vieras IPC/MCP-asiakas, väärennetty kutsujarooli, vanha oikeustodiste ja
  toisen työn peruutus torjutaan. Oikeustodisteita ei päädy koetuloksiin.
- Mallin tai API-aineiston ohje, ylimääräinen kenttä, uudelleenohjaus tai
  XML:n ulkoinen entiteetti ei avaa uutta oikeutta tai verkkokohdetta.
- UI:n synteettinen merkkitieto ei esiinny erillisessä MCP-kokeessa, eikä
  MCP-kokeen aineisto seuraavassa UI-vastauksessa. Koe toistetaan eri
  järjestyksissä ja peruutuksen jälkeen saman mallimoottorin kanssa.
- Malli ja säätyöntekijä eivät lue koeprofiilin ulkopuolista tiedostoa.
  Epäonnistunut eristyksen käyttöönotto ei käynnistä verkkokäyttöä.

Ajon näyttö erottaa sovelluksen hylkäämän pyynnön käyttöjärjestelmän
estämästä yhteydestä. Käytetään hallittua koepäätepistettä ja synteettistä
aineistoa; tulos sidotaan täsmälliseen sovellus- ja eristyskokoonpanoon.

Testit käyttävät omia tilapäisiä datajuuria ja paikallisia portteja.
Jokainen käynnistetty prosessi, palvelin ja ajastin suljetaan myös virheessä.
Käyttäjän havaintopaikat ja havaintopäiväkirja eivät ole testiaineistoa.

## Tarkistusten raportointi

Muutos ajetaan ensin sen vastuuseen kohdistuvilla testeillä. E2E ja oikean
mallin mittaukset tehdään, kun muuttunut käyttäjäpolku tai riski niitä tarvitsee.
Laajaa matriisia ei ajeta pelkän dokumentaatiomuutoksen vuoksi.

Kirjaa ajettu komento, tulos ja testaamatta jäänyt. Säilytä ensimmäisen
virheen havainto; korjauksen jälkeinen vihreä ajo ei selitä alkuperäistä syytä
automaattisesti. Tässä suunnitteluvaiheessa sovellustestejä ei ole.

Testimäärä raportoidaan nimetystä ajosta ja sen kohdejoukosta.
Testitiedostojen määrä ei ole testitapausten määrä. Parametrisoidut tapaukset,
eri projektien/selainten ajot ja uusinnat eritellään tarvittaessa;
lukumäärä ei yksin osoita testien hyödyllisyyttä tai kattavuutta.
