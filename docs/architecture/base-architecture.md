# Tähtiapurin perusarkkitehtuuri

Tila: suunnitteluehdotus, päivitetty 3.11.2026.
[Päätösten tila](../planning/decisions.md) erottaa käyttäjän linjaukset ehdotuksista.
Alla oleva kokonaiskuva sisältää myös tulevat osat. T02:n toteutetun
statusrungon ja viestisopimuksen omistaa [runkosuunnitelma](initial-skeleton-plan.md#t02n-toteutettu-runko).

## Ydinajatus

Modulaarinen TypeScript-sovellus: käyttöliittymä, Electron-runtime ja
paikallinen backend. Backendin application-kerros koordinoi käyttötapaukset,
domain omistaa havaintosäännöt ja sovittimet ulkoiset tekniikat.
Laskenta toimii ilman Electronia, kielimallia tai internetiä.

Backend on mukana ensimmäisessä toteutusrungossa.
Sen ei tarvitse aluksi käyttää verkkoa, tietokantaa tai oikeaa kielimallia.
[Runkosuunnitelma](initial-skeleton-plan.md) omistaa etenemisjärjestyksen;
[mallisuunnitelma](local-model-plan.md) mallirajapinnan ja toimituksen.

## Kansiorakenteen vaihtoehdot

A-vaihtoehto on valittu kevyen paikallismallipilotin pohjaksi.
B säilyy arvioituna vaihtoehtona. Rakennevalinta ei aloita toteutusta:
sovelluskansioita, paketteja tai koodia ei luoda tämän kuvan perusteella.
Alla olevat tarkat lähdepolut käyttävät valitun A-rakenteen nimityksiä.

### Vaihtoehto A: kevyt sovellus- ja pakettityötila

~~~text
Tähtiapuri/
  AGENTS.md
  README.md
  apps/
    web/src/
      app/                    # Sovelluksen kokoaminen
      features/
        sky-map/
        assistant/
        settings/
      shared/                 # Vain aidosti yhteiset UI-osat
    desktop/src/
      main/                   # Ikkunat, välitys ja prosessien elinkaari
      preload/                # Nimetyt ja rajatut UI-komennot
    mcp/src/                  # Rajattu stdio-kehityssovitin
    backend/src/
      ipc/                    # Ohut sisääntuleva prosessiviestiadapteri
      modules/
        observing/            # Paikat, välineet ja asetukset
        sky/                  # Kohdeaineisto ja laskentasovitin
        planning/             # Havaintoehdotusten käyttötapaukset
        assistant/            # Mallitehtävät, roolit ja työkalupolitiikka
        development/          # Kehitysistunto ja omiin kokeisiin rajatut oikeudet
        weather/              # Ennusteen sopimus ja tarjoajasovitin
      runtime/                # Backendin ja säätyöntekijän aloituspisteet
      composition/            # Porttien ja sovittimien kytkentä
  packages/
    domain/src/               # Puhtaat havaintosäännöt moduuleittain
    validation/src/           # Rajapintasopimukset ja rakennevalidointi
    api-client/src/           # UI:n nimetyt käyttötapaukset
  resources/
    catalogs/                 # Hyväksytty paikallinen tähtiaineisto
  docs/
    product/
    architecture/
    ai/
  tests/
    integration/              # Usean moduulin yhteistoiminta
    e2e/desktop/
    evaluations/assistant/
    fixtures/
    support/
~~~

Suositus tähän projektiin: A. apps/- ja packages/-jako erottaa sovellukset
ja yhteiset vastuut. Yhteisiä paketteja ehdotetaan vain kolmeen todelliseen
vastuuseen. Electronin, backendin ja mallisovittimen rajat pysyvät
selkeästi katselmoitavina.

Yksikkö-, komponentti- ja moduulikohtaiset integraatiotestit ovat lähdekoodin
vieressä. Testiperheet ja yhteisen tests/-puun tarkat rajat omistaa
[testausohje](../ai/testing-rules.md).

Moduulin sisälle lisätään application-, ports- ja adapters-jako tarpeen mukaan.
Portit määrittelee niitä tarvitseva käyttötapaus; composition tuntee
konkreettiset toteutukset. Jokaiselle moduulille ei perusteta omaa prosessia
tai package.json-tiedostoa.

### Vaihtoehto B: yksi paketti ja kerrokset src-puussa

~~~text
Tähtiapuri/
  AGENTS.md
  README.md
  src/
    web/                      # app, features ja yhteiset UI-osat
    desktop/                  # main ja preload
    backend/                  # ipc, modules, runtime ja composition
    domain/                   # Puhtaat havaintosäännöt
    validation/               # Rajapintasopimukset
    api-client/               # UI:n nimetyt käyttötapaukset
  resources/
    catalogs/
  docs/
    product/
    architecture/
    ai/
  tests/
    integration/
    e2e/desktop/
    evaluations/assistant/
    fixtures/
    support/
~~~

B vähentää workspace-pakettien ja niiden rakennusasetusten määrää. Sama
Electron/TypeScript-toteutus ja samat prosessivastuut ovat mahdollisia.
Importtirajat pitää valvoa kansioiden välillä, koska paketit eivät ilmaise
niitä yhtä suoraan. UI:n rakennus ei saa niputtaa backend- tai Node-koodia
rendereriin.

| Kysymys | A | B |
| --- | --- | --- |
| Sovellus- ja pakettijako | Sovellukset ja yhteiset paketit erotettu. | Samat kerrokset yhden lähdepuun sisällä. |
| Työkaluketjun määrä | Workspace ja muutama rajattu paketti. | Yksi paketti, useat rakennuskohteet. |
| Muistin ja prosessien tarve | Valittu ajotapa ja malli ratkaisevat. | Sama; kansiopuun tiivistys ei pienennä kielimallia. |
| Testit | Yksikkö-, komponentti- ja moduulitestit lähteen vieressä; laajat testit tests/-puussa. | Sama sijoitteluperiaate src/-rakenteessa. |

A on valittu modulaarisen paikallismallipilotin tarpeisiin.
Tämä ei tarkoita, että monorepo olisi aina parempi pieneen sovellukseen.
Hakemistoja ja paketteja luodaan vasta niiden todelliseen tarpeeseen.
Reactin ja muiden työkalujen valinta on erillinen asia.
[UI- ja tekniikkaehdotus](technology-and-ui-plan.md) omistaa
alustavan riippuvuuskartan sekä sääpalveluvertailun.
React/Vite ja oma CSS Modules -tyylitys on hyväksytty tekniseksi suunnaksi.
T07:n [tähtikarttasopimus](sky-map.md) kuvaa toteutetun paikallisen piirron,
kohdevalinnan sekä nimetyt snapshot/select-operaatiot.

Main–backend-yhteys on sovittu suoraan IPC:hen; siihen ei lisätä
HTTP-frameworkia. Mahdollinen myöhempi HTTP-sovitin arvioidaan erikseen.
Yleistä utils-, auth-, cloud- tai agenttikehystä ei tarvita alkuun.
Mallimoottori ja säätyöntekijä ovat prosessirajoja, eivät uusia liiketoimintapalveluita.
Kansiorakenne ei itsessään toteuta niiden tietoturvaeristystä.

Mallipainot, moottoribinäärit ja käyttäjän tallennetut paikat eivät kuulu
lähdekoodipuuhun tai versionoitavaan catalogs/-aineistoon. Niiden omistavat
resurssi- ja käyttäjädatajuuret ratkaistaan mallin toimituksessa ja kohdassa 5.
Paketoitava moottori ja malli voidaan myöhemmin liittää hyväksytystä resurssijuuresta.

## Pilotin laajuus

Kevyt rakenne säilyttää kerrosjaon ja luottamusrajat, mutta toteuttaa
aluksi vain ensimmäisen käyttäjäpolun vastuut.
Taulukot kuvaavat omistajuutta; jokainen vastuu ei tarvitse omaa pakettia,
prosessia, palvelua tai ennakkoon luotua kansiota.

Alkuun riittävät käyttöliittymä, Electron-main ja pieni backend sekä
ensimmäisessä mallikokeessa erillinen mallimoottori. Säätyöntekijä tulee
verkkokokeeseen. Yksi ladattu malli ja yksi opastajarooli luovat lähtötason.
Yhteistä sovelluskehystä, yleistä agenttialustaa, pilveä, yritysrooleja,
synkronointia tai laajaa tallennusta ei rakenneta etukäteen.

Siirrettävyys tarkoittaa ensin mallisovittimen, työkalupolitiikan, elinkaaren
ja arviointikäytännön kokeilemista vastaavissa rajoissa. Pieni koostamiskohta
kytkee konkreettiset sovittimet omiin portteihin ilman riippuvuuksien
injektointiin tarkoitettua frameworkia. Todellinen mallikoe tehdään varhain
[runkosuunnitelman](initial-skeleton-plan.md) mukaan.

## Omistajuus ja riippuvuudet

| Osa | Vastuu |
| --- | --- |
| observing | Käyttäjän valitsema paikka, välineet, mieltymykset ja horisonttiesteet. |
| sky | Kohdeaineisto ja laskentapalvelun julkinen sopimus; laskentakirjasto sovittimen takana. |
| planning | Havaittavuuden ehdot, ehdokasjoukko ja havaintosuunnitelman hyväksyminen. |
| assistant | Rajatut agenttiroolit ja mallitehtävien koordinointi. |
| weather | Ennusteen oma tietomalli, saatavuus ja tuoreus. |

Puhtaat säännöt ovat domain-paketissa moduuleittain. Backend-moduulissa ovat
sen application-käyttötapaukset, portit ja sovittimet. Domain ei importoi
backendia, Electronia, HTTP:tä, mallimoottoria tai tallennuskirjastoa.
Application saa omia tyyppejä, ei frameworkin request- tai context-olioita.

Rajapinnan rakennevalidointi ei korvaa backendin käyttötapaus- ja
oikeustarkistuksia. Moduulit käyttävät toistensa julkisia sopimuksia,
eivät sisäisiä tiedostoja. Composition kytkee toteutukset portteihin;
sitä ei importoida domainista tai käyttötapauksista.

## Prosessit ja kulkureitti

Käyttäjän päätös 3.11.2026: sovelluksen oma backend, mallimoottori ja
säätyöntekijä sulkeutuvat Tähtiapurin mukana. Ensimmäiseen versioon ei
lisätä erillistä taustatilaa. Codexin MCP-yhteys ei pidä sovellusta käynnissä.

~~~mermaid
flowchart LR
  UI["Käyttöliittymä"] -->|"Rajattu preload ja IPC"| MAIN["Electron main"]
  MAIN -->|"Suora IPC"| B["Backendin käyttötapaukset"]
  C["Codex"] -->|"stdio"| MCP["Kehityksen MCP-sovitin"]
  MCP -->|"Capability / named pipe"| MAIN
  B -->|"Mallisovitin"| M["Paikallinen mallimoottori"]
  B -->|"Sääportti"| W["Eristetty säätyöntekijä"]
  W -->|"Rajattu HTTPS"| F["Ilmatieteen laitos"]
~~~

Kuva esittää kutsureittejä. Electron main omistaa sovelluksen prosessien
elinkaaren, backend omistaa käyttötapaukset. Preload on käyttöliittymän
rajattu välityskerros. MCP-sovittimen käynnistää Codex; sen prosessi
ei kuulu Electronin suljettaviin lapsiprosesseihin.

### Yhteystapojen ehdotus

| Yhteys | Kuljetus ja rajaus |
| --- | --- |
| Renderer → main | Nimetyt preload-operaatiot Electron IPC:llä. Main tarkistaa lähettäjän, operaation ja aineiston; vapaata IPC- tai HTTP-proxyä ei tarjota. |
| Main → backend | Sovittu suora IPC. Main antaa kanavan käynnistämälleen backendille; tämän yhteyden HTTP-palvelinta ei rakenneta. UtilityProcess/parentPort ja T02:n viestisopimus kuvataan [runkosuunnitelmassa](initial-skeleton-plan.md#t02n-toteutettu-runko). |
| Backend → mallimoottori | Mallisovittimen takana oleva rajattu paikallinen yhteys. Tarkka kuljetus valitaan moottorikokeessa; renderer ja MCP eivät käytä moottorin raakaa APIa. |
| Backend → säätyöntekijä | Yksityinen, nimettyyn ennustepyyntöön rajattu prosessiyhteys. Työntekijä saa vain ennusteen tarvitsemat tiedot. |
| Codex → MCP-sovitin | Sovittu stdio-MCP. Kehitysyhteyden sopimuksen ja oikeudet omistaa [mallisuunnitelma](local-model-plan.md#kehitys--ja-diagnostiikkarajapinta-paikalliseen-malliin). |
| MCP-sovitin → backend | T05: mainin erillinen Windows named pipe ja capability → backendin rajattu kehitysmoduuli. Kutsujan omistajuus ja sulku tarkistetaan backendissä; main–backend-session oikeutta ei jaeta. |

Backend toteutetaan Node/TypeScript-prosessina. Electronin utilityProcess
on arvioitava ajotapa backendille; natiivi mallimoottori on oma apuprosessinsa.
Main välittää käynnistystiedot ja sulkukäskyt yksityisellä prosessikanavalla.
Säätyöntekijä lisätään vasta verkkokokeessa. Prosessijako ei itsessään
toteuta käyttöjärjestelmäeristystä.

Käyttäjä valitsi 3.11.2026 mainin ja backendin yhteydeksi suoran IPC:n.
Omat erilliset prosessit viestivät rajattujen kanavien kautta; saman prosessin
moduulit kutsuvat toistensa julkisia sopimuksia tavallisina funktiokutsuina.
Valinta ei määrää mallimoottorin mahdollista omaa HTTP-kuljetusta.

Main ei paljasta backendin kanavaa tai raakaa IPC:tä rendererille.
Backend hyväksyy vain nimetyt operaatiot ja validoidun, rajatun aineiston.
Protokollan versio, pyyntöjen ja vastausten tunnisteet, käyttöoikeuskonteksti,
määräaika ja peruutus määritellään viestisopimukseen. Kanavan saaminen ei
korvaa omistavan käyttötapauksen oikeus- ja sisältötarkistuksia.
Käyttötapaukset pysyvät kuljetustavasta riippumattomina.

### Paikallinen HTTP vai suora prosessikanava

IPC tarkoittaa prosessien välistä viestintää yleisesti; myös HTTP voi
välittää sitä. Tässä vertailussa suora IPC tarkoittaa mainin ja sen
käynnistämän backendin omaa viestikanavaa, esimerkiksi utilityProcessin
MessagePort-yhteyttä. MessagePort on viestikanavan pää, ei kuunteleva TCP-portti.
Rendererin ja mainin välillä käytetään rajattua Electron IPC:tä molemmissa
vaihtoehdoissa. Nyt valitaan vain mainin ja backendin yhteyttä.

| Näkökulma | Loopback-HTTP | Suora prosessikanava |
| --- | --- | --- |
| Oppiminen ja työkalut | Tuttu reitti-, pyyntö- ja vastausmalli sekä paljon valmiita työkaluja. | Paikallinen viestiprotokolla on opeteltava; Electron tarjoaa kanavan välineet. |
| Yhteyden rajaus | Kuunteleva paikallinen portti ja käyttöoikeustodiste on hallittava. | Main voi antaa kanavan suoraan lapsiprosessille ilman tämän yhteyden HTTP-palvelinta. |
| Toteutettava sopimus | HTTP tarjoaa yleiset pyyntö- ja vastausrakenteet; omat tietotyypit, oikeudet ja tehtävärajat tarvitaan silti. | Operaatiot, pyyntöjen ja vastausten yhdistäminen, virheet, peruutus ja rajat määritellään viestisopimukseen. |
| Testaus | HTTP-rajalle on valmiita testausvälineitä; portin ja käyttöoikeustodisteen elinkaari testataan erikseen. | Kanavalle tarvitaan oma pieni testiasiakas; käyttötapaukset testataan edelleen ilman Electronia porttien kautta. |
| Myöhempi erillinen palvelu | HTTP-sovitin on jo olemassa, mutta etäkäyttö vaatii erillisen turvallisuus- ja identiteettimallin. | HTTP-sovitin voidaan lisätä myöhemmin samoihin käyttötapauksiin; sitä ei synny ilmaiseksi. |
| Oppimistavoite | Harjoittelee API-kuljetusta ja sen suojauksia. | Harjoittelee moduulirajoja, mallijonoa ja elinkaarta prosessikanavalla. |

Kummassakin backend validoi pyynnöt ja omistaa toimintojen oikeustarkistukset.
Prosessikanava ei eristä tiedosto- tai verkkokäyttöä. Myös loopback-palvelun
saavutettavuus ja mahdollinen suora pääsy muista prosesseista todennetaan.
Tämä valinta ei poista mallimoottorin mahdollisen oman HTTP-yhteyden
rajaustarvetta eikä muuta erillistä stdio-MCP-kehitysyhteyttä.

Käyttäjän valinta 3.11.2026 on suora IPC paikalliseen desktopiin.
Perusteina ovat rajattu paikallinen kanava ja IPC:n oppiminen käytännössä.
Yksi kuunteleva HTTP-palvelin ja sen HTTP-istunnon hallinta jäävät pois.
Valinta tarkentaa sisääntulosovittimen ja sen kansion, ei domainin tai
moduulien omistajuutta. HTTP säilyy arvioituna vaihtoehtona mahdollista
myöhempää tarvetta varten. Suorituskykyeroa ei ole mitattu.

### Käynnistys ja sulkeminen

Käynnistyksen tekninen ehdotus:

1. Main avaa paikallisen käyttöliittymän ja käynnistää backendin.
   Valmius todennetaan erikseen viestillä ja yhteensopivalla sopimusversiolla.
2. Backend ottaa käyttöön havaintokontekstin ja laskee nykyhetken kartan.
   Kartta ei odota mallimoottorin latausta tai säätä.
3. Main käynnistää hyväksytyn mallimoottorin. Mallin lataus, illan laskenta
   ja käyttäjän asetuksen sallima säävalmistelu voivat edetä rinnakkain.
   Backend kokoaa yhden yhteisen katsauksen aineiston käyttötapauksen mukaan.
4. Kehitysportti avataan vain erikseen aktivoituun diagnostiikkaistuntoon.
   MCP-koe käyttää samaa mallijonoa ja resurssirajoja kuin UI.
   Sovelluksen puuttuessa MCP palauttaa saatavuusvirheen eikä käynnistä
   toista backendia tai mallia automaattisesti.

Sulkemisessa main estää uudet pyynnöt ja mitätöi kehitysyhteyden.
Backend peruu mallitehtävät ja säähaut. Keskeneräisten tallennusten
eheys sovitaan tiedon elinkaaressa; sulkukäsky ei yksin todista sitä.
Main odottaa rajatun ajan ja sulkee vain itse omistamansa prosessit.
Poistuminen todennetaan myös epäonnistuneen käynnistyksen ja pakotetun
sulkemisen jälkeen. Pelkkää vanhaa PID:tä tai koneen kaikkia samannimisiä
prosesseja ei käytetä sulkemisen perusteena.

MCP:n irtoaminen peruu vain sen omat koetehtävät, ei käyttöliittymän töitä.
Sovelluksen [kehitysyhteyskytkimen](local-model-plan.md#kehitysyhteyden-kytkin)
sulkeminen mitätöi backendin kehitysoikeuden myös Codexin ollessa kytkettynä.
Mallin kaatuminen jättää laskentakortit ja kartan käyttöön sekä näyttää
mallin virhetilan. Säävirhe näkyy puuttuvana ennusteena eikä anna backendille
verkkolupaa. Backendin kaatuminen katkaisee sen pyynnöt ja mitätöi vanhan
yhteyden; vanhaa tulosta ei esitetä uutena onnistumisena.
Toipumisen tarkat aikarajat ja uusintapolitiikka ovat avoinna.

Käyttöliittymän näkyvän toiminnan omistaa [käyttötapauskuvaus](../product/observing-session-use-cases.md).
Oikeusrajojen toteutus täsmennetään kohdassa 6 ja työkalut kohdassa 7.
Prosessien normaali ja pakotettu sulku sekä uusi käynnistys todennetaan
[testausohjeen](../ai/testing-rules.md) mukaan myös paketoidussa sovelluksessa.

Teknisen tarkennuksen taustalähteet (3.11.2026):
[Electronin IPC-ohje](https://www.electronjs.org/docs/latest/tutorial/ipc),
[utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process) ja
[Electronin turvallisuusohje](https://www.electronjs.org/docs/latest/tutorial/security).
Nämä eivät valitse Electron-versiota tai todista toteutuksen turvallisuutta.

## Agenttien ja mallimoottorin sijoittelu

Sovittu sijoitteluperiaate on pitää agenttien orkestrointi paikallisen backendin
assistant-moduulin application-kerroksessa ja mallin laskenta erillisessä
hallittavassa moottoriprosessissa. Electron main omistaa prosessien elinkaaren
ja valvotun UI-välityksen. Domain ja omistavat moduulit säilyttävät sääntönsä.

[Avustajan työnkulkusuunnitelma](assistant-orchestration-plan.md) omistaa
ohjelmakoodin koordinaattorin, malliroolien, delegoinnin ja työkalujen
työnkulun ja sen arviointiperiaatteet. [Mallisuunnitelma](local-model-plan.md)
omistaa mallisovittimen, moottorin, mallivertailun ja kehitysrajapinnan.

Renderer näyttää kartan ja keskustelun sekä lähettää nimettyjä pyyntöjä.
Se ei isännöi työkalupolitiikkaa tai tarjoa mallimoottorin raakaa rajapintaa.
Mallin työkalukutsu on ehdotus; ohjelma tarkistaa sen ennen omistavan
moduulin sovellustoimintoa. Säätoiminnon ulkoisen yhteyden tekee vain
rajattu säätyöntekijä.

Backendin, moottorin ja säätyöntekijän sijainti omissa prosesseissa ei yksin
takaa eristystä. Käyttöjärjestelmän oikeusrajat valitaan ja todennetaan erikseen.

## Yhden havaintosuunnitelman kulku

1. Käyttäjä valitsee paikan, paikallisen ajan, aikavälin ja välineet.
2. Backend validoi kontekstin ja ratkaisee aikavyöhykkeen.
3. Laskentasovitin tuottaa geometrian aikavälille. Planning rajaa
   sääntöjen mukaiset ehdokkaat. Sään tila on tuore, vanhentunut tai puuttuva.
4. Mallille annetaan rajattu tehtävä ja tarkistettu aineisto. Se voi ehdottaa
   vain sallittujen työkalujen käyttöä; backend päättää kutsun suorittamisesta.
5. Ohjelma tarkistaa kohdetunnisteet, ajan, havaintorajat ja viittaukset.
   UI näyttää laskentaan perustuvat faktakortit ja niistä erillisen selityksen.

Aluksi yksi opastajarooli riittää. Myöhemmin suunnittelija ja opastaja voivat
käyttää samaa mallia vuorotellen. Planningin tarkistus on ohjelmakoodia.
Agentti ei hyväksy omia oikeuksiaan tai muuta havaittavuuden sääntöjä.

## Laskenta ja havaittavuus

T06:n snapshot-palvelun sopimuksen omistaa [tähtilaskenta](sky-calculation.md).
Alla oleva havaittavuuden kokonaisuus sisältää myös myöhemmät osat.

- Laskenta käyttää UTC-aikaleimoja. UI käyttää valittua aikavyöhykettä.
  Kesäaika, paikallinen keskiyö ja päivän vaihtuminen huomioidaan.
- Koordinaattikehykset, yksiköt ja laskennan ajankohta ovat osa sopimusta.
- Horisontin yläpuolella oleminen ei yksin takaa käytännön havaittavuutta.
  Huomioidaan demon laajuudessa korkeus, havaintoajan kesto, hämärä,
  välineet ja käyttäjän horisonttiesteet.
- Kuun vaikutus ja sää ovat kohdekohtaisia lisäehtoja. Käytössä olevat ja
  puuttuvat ehdot näytetään käyttäjälle.
- Liike ja sää arvioidaan aikaväliltä. Näytteenotto ja tarkkuus päätetään
  laskentakirjaston arvioinnissa.
- Laajennettavan kohdeluettelon nimet, koordinaatit ja opastustiedot tulevat
  kuratoidusta, versioidusta ja käyttöoikeuksiltaan tarkistetusta katalogista.
- UI:n suunta-, korkeus- ja aikatiedot tulevat laskennasta. JSON-muoto tai
  kelvollinen lähdetunniste ei yksin todista mallin selityksen oikeellisuutta.

## Taivaskartan toteutusehdotus

Käyttäjä hyväksyi kohdassa 2 kevyen tähtikartan mukaan ensimmäiseen versioon;
[tuoterajauksen](../product/project-definition.md) omistaja kirjaa laajuuden.
D3-Celestial on ensisijainen arvioitava piirtoadapteri. Tavoite on paikallinen
taivaskupu 2D-projektiona, jossa ovat tähdet, tähdistöviivat, horisontti ja
ilmansuunnat sekä Kuu ja planeetat.
Kohteen valinta yhdistää kartan kohdetietoihin ja keskusteluun.

Kartta on rendererin oma näkymä. Backendin sky-moduuli omistaa laskennan ja
katalogiportin; renderer omistaa projektion, piirron ja valinnan.
Kartta, kohdekortit ja mallin rajattu konteksti käyttävät validoitua paikka-
ja aikatietoa. Käynnistyksen nykyhetken kartalla ja illan katsauksella voi olla
eri ajankohta; nämä merkitään erikseen eikä niiden laskentatuloksia sekoiteta.
Koko tähtikatalogia ei syötetä mallille.

| Vaihtoehto | Arvio tämän harjoituksen kannalta |
| --- | --- |
| Rajattu oma Canvas-näkymä | Piirtotapa voidaan rajata tarkasti tarpeeseen. Projektion, valinnan ja nimilappujen työ sekä oikeellisuus pitää toteuttaa ja todentaa. |
| D3-Celestial-sovitin | Valmis karttakirjasto tarjoaa tähtiä, tähdistöjä ja kartan vuorovaikutusta. Sovitettavuus omaan laskentaan, riippuvuudet, offline-toiminta ja aineistojen oikeudet tarkistetaan kokeessa. |
| Stellarium Web Engine | WebGL-planetaario tarjoaa muun muassa ilmakehäsimulaatiota ja tekstuureja. Paketoinnin, aineistojen, verkkotarpeiden ja AGPL-lisenssin vaikutus arvioidaan ennen valintaa. |

Arvio: rajattu uskottava kartta on erillinen, kohtuullisesti rajattava
ominaisuus. Laaja planetaario on selvästi suurempi toteutus- ja ylläpitotyö.
Tämä on suhteellinen suunnitteluarvio, ei mitattu työmäärä tai aikataululupaus.

Kartta ei edellytä ulkoista kartta-APIa: valittu ja lisensoitu tähtiaineisto
voidaan toimittaa paikallisesti. Myös piirto-ohjelma, riippuvuudet, fontit ja
muut resurssit toimitetaan paikallisina; etä-CDN ei kuulu havaintokäyttöön.
Sääennuste pysyy omana rajattuna API-toimintonaan.
Jos piirtoadapterilla on oma planeettalaskenta tai etäaineistoja, niistä ei
tehdä rinnakkaista totuutta tai luvattomia verkkoyhteyksiä.
Kohteen tunniste ja paikan/ajan konteksti validoidaan ennen työkalukutsua.

Ennen toteutusvalintaa rajataan karttakoe: offline-käynnistys, tunnetun
havaintopaikan ja ajan tähtipaikat, koordinaatistojen muunnokset, kohdevalinta,
nimien luettavuus sekä samanaikaisen malliajon sujuvuus.
D3-Celestialin tarkkaa versiota tai aineistopakettia ei ole hyväksytty tai asennettu.

Taustalähteet:
[D3-Celestial](https://github.com/ofrohn/d3-celestial),
[Stellarium Web Engine](https://github.com/Stellarium/stellarium-web-engine) ja
[Astronomy Enginen koordinaatti- ja magnitudisopimukset](https://github.com/cosinekitty/astronomy/tree/master/source/js).

## Turvallisuusrajat

Osien oikeudet, turvallisen koodin periaatteet ja käyttöjärjestelmän
eristyksen todentamisen ehdot omistaa
[turvallisuussuunnitelma](security-and-permissions-plan.md).
Prosessijako, IPC, loopback tai Electronin utilityProcess eivät yksin
toteuta näitä rajoja. Alla kuvataan sääkäyttötapauksen kulku ja sen
sovelluskohtainen sopimus; verkkoluvan valvonta kuuluu turvallisuussuunnitelmaan.

## Säätoiminnon valvottu kulkureitti

Käynnistyksen illan katsaus kootaan yhtenäiseksi taivas- ja sääaineistosta;
säähaun valmistelua voidaan ajaa rinnakkain paikallisten laskentojen kanssa.
Käyttäjälle näkyvän toiminnan ja aikakatkaisun poikkeuspolun omistaa
[käyttötapauskuvaus](../product/observing-session-use-cases.md).

~~~text
Käynnistysasetus tai käyttäjän sääpäivityspyyntö
  -> desktopin valvottu paikallinen sovellusrajapinta
    -> backendin sääkäyttötapaus ja työkalupolitiikka
      -> rajattu säätyöntekijä
        -> ennalta valittu sää-API HTTPS-yhteydellä
      <- validoitu ja normalisoitu ennuste
    -> katsaus, kohdekortti tai paikallisen mallin rajattu konteksti
~~~

Tämä on tekninen toteutusehdotus. Säärooli saa pyytää vain nimettyä
ennustetyökalua; se ei saa yleistä fetch-, URL-, tiedosto- tai shell-työkalua.
Säärooli ei tarvitse omaa kielimallia. Automaattinen haku voidaan käynnistää
ohjelmakoodista ilman mallin päätöstä. Muiden agenttiroolien mahdolliset
sääpyynnöt välitetään saman omistavan säätoiminnon kautta.

Backend johtaa paikan, aikavälin ja sallitun käynnistystavan luotetusta
sovelluskontekstista. Työkalu ei ota mallilta URL:ia, palveluntarjoajaa,
otsakkeita tai mielivaltaista hakutekstiä. Säätyöntekijällä ei ole tarvetta
lukea keskustelua, havaintopäiväkirjaa tai koko käyttäjäprofiilia.

Säätyöntekijä hyväksyy vain valitun tarjoajan ja rajatut ennustekentät.
HTTP-uudelleenohjaukset, kohdeosoitteet ja vastausten rakenne tarkistetaan;
koko, kesto, uusinnat ja kutsutiheys rajataan. Ulkoinen aineisto on dataa,
ei ohjelma- tai agenttiohje. Ennuste palautetaan omana tietomallina, jossa on
lähde, noutoaika ja voimassaolo. Puuttuva tieto pysyy puuttuvana.

Vain säätyöntekijän ulkoisen verkkoluvan toteutuksen, alustavaihtoehdot
ja käyttöönoton ehdot omistaa
[turvallisuussuunnitelma](security-and-permissions-plan.md#verkon-ja-tiedostojen-todellinen-eristys).
API-pyynnön rajattu sisältö ei yksin todista prosessin verkkorajaa.

Ohjelmiston ja mallien hankinta/päivitys ovat erillisiä ylläpitotoimintoja.
Niiden yhteyksiä ei anneta havaintotyön agenttien käyttöön.

Suunnittelun taustalähteet:
[OWASPin SSRF-rajaukset](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) ja
[Node.js:n käyttöoikeusmallin rajoitukset](https://nodejs.org/api/permissions.html).

## Tallennus ja ylläpito

Ensimmäinen tekninen kokeilu voi toimia muistissa. Käyttöversion
käyttäjätiedon, historian ja välimuistien tallennussopimuksen omistaa
[tiedon elinkaari](data-lifecycle-plan.md). Se erottaa sovitut säilytettävät
tiedot formaatti-, poisto- ja palautusehdotuksista. Tallennusratkaisu
eristetään omistavan moduulin portin taakse.

Mallien hankinta ja ohjelmistopäivitykset ovat erillisiä ylläpitotoimintoja.
Ne eivät anna kielimallille ajonaikaista verkkolupaa.
Toimituksen suunnitelman omistaa [mallisuunnitelma](local-model-plan.md).

## Vertailupohja ja lähteet

Suunnittelussa sovelletaan modulaarista kerrosjakoa ja rajattuja
sovittimia. Käytettävien tekniikoiden omat lähteet tukevat suunnittelua;
muiden projektien riippuvuuksia tai ominaisuuksia ei siirretä automaattisesti.

- [Electronin turvallisuusohje](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electronin prosessimalli](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Astronomy Engine -ehdokas](https://github.com/cosinekitty/astronomy)

Lähteet tukevat suunnittelua; ne eivät ole asennus- tai riippuvuuspäätöksiä.
