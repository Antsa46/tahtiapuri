# Tähtiapuri

Keskusteleva paikallinen tähtitaivaan apuri, joka antaa havaintopaikkaan
sidotun katsauksen illan taivaaseen ja jatkaa siitä keskustelua suomeksi.

Projektin painopiste on paikallisen kielimallin käytön oppiminen toimivan
Electron-ohjelman osana. Tähtitaivas antaa harjoittelulle käytännön käyttökohteen.
EKYssä voidaan myöhemmin hyödyntää opittuja rajapintoja, testausmenetelmiä ja
paketointikäytäntöjä.

## Nykytila 3.11.2026

Vain suunnittelu ja työohjeet. Tässä kansiossa ei ole sovelluskoodia,
pakettimanifestia, asennettuja riippuvuuksia tai ajettavaa sovellusta.
tests/-hakemistot ovat tyhjä varaus tuleville testeille.

- Perusohje: [AGENTS.md](AGENTS.md)
- Aihekohtainen lukureitti: [docs/README.md](docs/README.md)
- Koko projektin vaiheet ja työpaketit: [roadmap](docs/planning/roadmap.md)
- Kehityksen GPT-mallisuositukset: [työnjako](docs/ai/development-models.md)
- Yhteinen kehitystapa ja aloituskohdat: [aloituslista](docs/ai/project-start-checklist.md)
- Käyttäjä, tarkoitus ja tavoitteet: [projektin määrittely](docs/product/project-definition.md)
- Käynnistys, keskustelu, karttavalinta ja sääpäivitys: [käyttötapaukset](docs/product/observing-session-use-cases.md)
- Rakenne ja prosessit: [perusarkkitehtuuri](docs/architecture/base-architecture.md)
- Oikeudet ja eristyksen todentaminen: [turvallisuussuunnitelma](docs/architecture/security-and-permissions-plan.md)
- Käyttäjätiedot, historia ja palautettavuus: [tiedon elinkaari](docs/architecture/data-lifecycle-plan.md)
- Backend ja toteutuksen vaiheistus: [runkosuunnitelma](docs/architecture/initial-skeleton-plan.md)
- Mallikokeet ja myöhempi toimitus: [paikallisen mallin suunnitelma](docs/architecture/local-model-plan.md)
- Lähteen vieressä olevat testit ja keskitetty E2E: [testausohje](docs/ai/testing-rules.md)

Tämä README omistaa projektin yleisen nykytilan, päätösyhteenvedon ja jatkamiskohdan.
Aihekohtaiset vastaukset ja perustelut ovat lukureitin osoittamissa dokumenteissa.
Suunnitelmien lähdepolut kuvaavat tulevaa rakennetta.

## Työmäärän reunaehto

Tähtiapuri etenee rajattuina oppimis- ja toteutuspaloina. Omaa
kalenteriaikataulua ei ole sovittu.
[Työmäärän vaikutus rajaukseen](docs/product/project-definition.md#aikataulu-ja-työmäärän-rajaus)
on kirjattu. Henkilökohtaiset aikataulumuistiinpanot säilyvät paikallisesti.

## Aloituskierroksen eteneminen

**Kohta 1/10 on käsitelty:** käyttäjän tavoite on havaintopaikan tunteva,
keskusteleva illan tähtiavustaja. [Tarkoitus ja tavoite](docs/product/project-definition.md)
on kirjattu käyttäjän vastauksen perusteella.
**Kohta 2/10 on käsitelty:** ensimmäisen version rajaus ja kevyt kartta on hyväksytty.
**Kohta 3/10 on käsitelty pääkäyttötapausten tasolla:** nykyhetken kartta,
yhteinen illan katsaus, keskustelusta ohjattava kartta ja sääasetukset on sovittu.
[Käyttötapaukset ja lisäehdotukset](docs/product/observing-session-use-cases.md)
on kirjattu. Tarkat poikkeusrajat täsmennetään teknisessä suunnittelussa.
**Kohta 4/10 on käsitelty päälinjojen tasolla:** arkkitehtuurin, omistajuuksien ja
[alustavan tekniikkakartan](docs/architecture/technology-and-ui-plan.md)
vertailu EKYyn on kirjattu. React/Vite ja oma CSS Modules -tyylitys on
hyväksytty tekniseksi suunnaksi. Poro 2 8B Instruct ja Ministral 3 8B Instruct
on sovittu ensimmäiseen kvantisoitujen mallien vertailuun. Käyttäjä valitsi
kansiorakenteen A pohjaksi ja hyväksyi [avustajan työnkulun perusmallin](docs/architecture/assistant-orchestration-plan.md).
[Prosessiyhteydet ja elinkaari](docs/architecture/base-architecture.md#prosessit-ja-kulkureitti)
on tarkennettu. Käyttäjä päätti, että backend, mallimoottori ja säätyöntekijä
sulkeutuvat sovelluksen mukana. Main–backend-yhteydeksi valittiin suora IPC.
Viestisopimuksen yksityiskohdat, oikeuksien toteutus, aikarajat ja täsmäriippuvuudet
ovat avoinna ja ratkaistaan ennen niitä tarvitsevaa toteutusta.
**Kohta 5/10 on käsitelty päälinjojen tasolla:** [tiedon elinkaari ja tallennus](docs/architecture/data-lifecycle-plan.md).
Paikat, viimeisin paikkavalinta, sääasetus, poistettava keskusteluhistoria
ja viimeisin onnistunut ennuste per paikka säilyvät paikallisesti.
Historia säilyy käyttäjän poistoon asti. Vienti ja palautus rajattiin myöhemmäksi.
Tallennusformaatti ja tekniset eheysrajat täsmennetään ennen toteutusta.
**Kohta 6/10 on käsitelty päälinjojen tasolla:** [luottamusrajat ja käyttöoikeudet](docs/architecture/security-and-permissions-plan.md).
Sovittu suunta on erillinen käyttöjärjestelmätasolla rajattu malliprosessi,
ohjelman ja moottorin yhteinen asennus sekä vain säätyöntekijän ulkoinen
verkkolupa. Mallipainojen toimitus täsmennetään kohdassa 7.
Pysyvät muutokset tehdään ohjelman omista valikoista ja painikkeista.
MCP-kehitysyhteys on oletuksena suljettu ja avataan asetuksista käyttökerraksi.
Windows-eristyksen mekanismi, GPU-/IPC-yhteensopivuus ja oikeusrajojen
todentaminen ovat edelleen kokeella selvitettäviä. Niitä ei ole toteutettu.
Mahdollinen oikean käyttäjäaineiston välitys MCP:n kautta on avoinna eikä
sille ole annettu käyttöoikeutta.
**Kohta 7/10 on käsitelty päälinjojen tasolla:** [mallivalinta ja toimitus](docs/architecture/local-model-plan.md).
Sovittu suunta on asetusten mallinvaihto, ulkoinen paikallinen mallikansio,
yksi malli muistissa ja 4B/8B-aloitus. Käyttäjä hyväksyi suunnittelulinjan,
jossa node-llama-cpp:tä arvioidaan ensin erillisessä UtilityProcessissa.
AppContainer/LPAC pysyy avoimena eristyskokeena; ensimmäisen yhteensopivuuskokeen
ympäristö ja oikeudet täsmennetään ennen ajoa. Vain säätyöntekijä nettiin
säilyy havaintokäytön tavoitteena. Tarkat versiot, painot ja CUDA-/paketointi-
yhteensopivuus ovat kokeella selvitettäviä; asennuksia ei ole tehty.
**Kohta 8/10 on käsitelty päälinjojen tasolla:** [testaus ja ensimmäinen hyväksymiskoe](docs/ai/testing-rules.md#ensimmäinen-tekninen-hyväksymiskoe).
Käyttäjä valitsi rajatun mallikokeen ennen koko käyttöliittymän viimeistelyä.
4B ja 8B saavat samat taivastiedot ja sääfixturen; arvioidaan keskustelu,
työkalupyynnöt, viive, muisti sekä virheistä palautuminen. Testit ajetaan
paikallisesti ilman etä-CI:tä. Tarkat aineistot ja suorituskyvyn tavoiterajat
täsmennetään ennen niiden hyväksymistä.
**Kohta 9/10: roolijako on sovittu, mallikohtainen työnjako on suositus.**
[Pääkehittäjä ja kriittisten muutosten tarkastaja](AGENTS.md#kehitystyön-roolit-ja-katselmus)
säilyvät. Uusi [mallityönjako](docs/ai/development-models.md) ehdottaa
6.1 Solia pääosaan toteutuksesta, Astraa vaativiin suunnitelmiin ja
riskikatselmuksiin sekä Terraa tarvittaessa visuaaliseen ja kirjoittavaan
työhön. Tämä ei muuta työistunnon mallia tai sovelluksen mallirooleja.
**Kohta 10/10 on käsitelty päälinjojen tasolla:** ohjeiden ja yhteisten käytäntöjen ylläpito.
Käyttäjä valitsi ensimmäisen oman skillin luonnostelun suunnittelukierroksen
lopuksi. [task-start-finish-luonnos](docs/ai/skills/task-start-finish/SKILL.md)
ohjaa tehtävän rajaukseen, omistaviin ohjeisiin ja valmistumisen näyttöön.
Luonnos on dokumenteissa; sitä ei ole asennettu Codexin skillivalikoimaan
tai kokeiltu todellisessa toteutustehtävässä. Yksi omistaja per sääntö,
lyhyt pääohje ja ajantasainen ohjekartta säilyvät periaatteina.

Kymmenen kohdan aloituskierros on kirjattu. Koko projektin
[roadmap](docs/planning/roadmap.md) ja mallikohtaiset suositukset
täydentävät sitä. Avoimet koetulokset eivät ole ratkaistuja, eikä
suunnitelman kirjoittaminen käynnistä sovelluksen toteutusta.

## Käyttäjän vahvistama suunta

- Projektin nimi on Tähtiapuri ja sillä on oma alikansio laboratoriossa.
- Edetään rauhassa suunnittelemalla; sovelluskoodia ei vielä tehdä.
- Desktopin suunta on Electron ja TypeScript. Käyttöliittymän suunta on
  React ja Vite sekä oma CSS Modules -tyylitys; täsmäversiot päätetään erikseen.
- Rakenteen logiikka seuraa EKYn moduuli- ja kerrosjakoa. Kansiorakenteen
  A-vaihtoehto on valittu pohjaksi: apps/web, apps/desktop, apps/backend
  ja rajatut yhteiset paketit. Juuressa ovat perusohjeet ja docs/-alikansioissa
  aihekohtaiset dokumentit.
- Projektin pääasia on paikallisen mallin käytännön käyttö ohjelman osana.
- Backendin assistant-koordinaattori ohjaa työnkulkua ohjelmakoodissa.
  Malliroolit ehdottavat, ja omistavat moduulit tarkistavat toiminnot.
- Electron mainin ja backendin yhteys käyttää suoraa IPC:tä. Omat
  prosessirajat käyttävät rajattuja kanavia; saman prosessin moduulikutsut
  ovat tavallisia funktiokutsuja. Mallimoottorin oma kuljetus arvioidaan erikseen.
- Asetusten ja tallennettujen havaintopaikkojen muutokset sekä historian
  poistaminen tehdään vain ohjelman omista valikoista ja painikkeista.
  Näitä toimintoja ei anneta avustajan tai MCP-kehitysyhteyden työkaluiksi.
- Mallimoottori toimii erillisessä, käyttöjärjestelmätasolla rajatussa
  prosessissa. Ohjelma, moottori ja tarvittava käynnistäjä suunnitellaan
  samaan asennuspakettiin ilman erillistä kielimallipalvelimen asennusta.
  Vertailumallien painot säilyvät erillisessä paikallisessa mallikansiossa.
  Mallikokeen ajotapana arvioidaan ensin node-llama-cpp:tä UtilityProcessissa.
  Windowsin AppContainer/LPAC säilyy avoimena eristysvaihtoehtona.
  Käyttöjärjestelmärajat ja GPU-yhteensopivuus varmennetaan erikseen.
- Sovelluksen oma backend, mallimoottori ja säätyöntekijä sulkeutuvat
  ohjelman mukana. Ensimmäisessä versiossa ei ole erillistä taustatilaa;
  Codexin MCP-yhteys ei pidä sovellusta tai mallia käynnissä.
- Codexin rajattu kehitysyhteys paikallisen mallin kokeiluun tehdään
  suunnitelmassa suoraan paikallisella stdio-MCP:llä. Asetuksiin lisätään
  kehitysyhteyden kytkin; yhteys on oletuksena pois joka käynnistyksessä.
  Sen sopimuksen ja tietosuojarajat omistaa mallisuunnitelma; toteutusta tai asetuksia ei vielä ole.
- Mallikokeet aloitetaan 4B- ja 8B-malleilla. Vertailukokoelmaan kuuluvat
  myös Poro 2 8B Instruct ja Ministral 3 8B Instruct kvantisoituina.
  Tarkat kvantisoinnit, moottoribuild ja resurssien hankinta sovitaan
  ennen kokeen toteutusta.
- Paikallismallia voi vaihtaa asetuksista. Useita hyväksyttyjä mallipaketteja
  voi säilyttää erillisessä paikallisessa mallikansiossa; muistissa pidetään
  yhtä mallia kerrallaan. Mallinvaihto ei muuta avustajan oikeuksia.
- Mallivertailuun lisätään 4B-kokoluokka. Tähtiapurin koko mallivalikoimaa
  ei paketoida asentimeen; EKYn kevyen mallin toimitus ratkaistaan erikseen.
- Paikallinen malli auttaa havainnoinnissa. Verkkokäyttö tapahtuu vain
  rajattujen API-työkalujen kautta; malli ei selaa verkkoa.
- Käyttäjä hallitsee tähtitaivaan perusteet ja haluaa keskustella illan
  tilanteesta. Paljain silmin havainnointi on keskeistä; kiikarit ja
  kaukoputki voidaan huomioida ilman oletuksia niiden tarkasta optiikasta.
- Ensimmäiseen versioon kuuluvat illan katsaus, keskustelu, Kuun ja
  planeettojen kohdetiedot, pilvisyysennuste ja kevyt paikallinen taivaskartta.
- Käynnistyksessä kartta näyttää nykyhetken. Paikallinen malli antaa yhden
  yhteisen illan katsauksen; automaattitilassa säähaun tulos liitetään siihen.
  Tarkentavat kohde- ja aikapyynnöt voivat ohjata karttaa nyt tai tulevaisuuteen.
- Asetuksista valitaan automaattinen säähaku käynnistyksessä tai haku
  pyydettäessä. Valinta säilyy käynnistysten yli; ensimmäisen käynnistyksen
  oletus on manuaalitila.
- Sääpalveluksi valittiin Ilmatieteen laitoksen avoin data. Tarkka
  ennustekysely ja kentät varmennetaan sovitinkokeessa.
- Viimeisin onnistunut ennuste säilyy paikallisesti havaintopaikoittain
  myös seuraavaan käynnistykseen. Ikä ja kattama ajanjakso näkyvät;
  vanhaa ennustetta ei esitetä tuoreena.
- Asetuksissa voi tallentaa muutamia nimettyjä havaintopaikkoja omilla
  koordinaateilla ja valita niistä aktiivisen. Paikat säilyvät käynnistysten yli.
  Käynnistys muistaa viimeksi käytetyn paikan ja näyttää sen nimen kartan yhteydessä.
- Keskustelut tallentuvat paikallisesti ja säilyvät, kunnes käyttäjä poistaa ne.
  Yksittäisen keskustelun tai koko historian voi poistaa. Paikallinen malli
  voi hyödyntää säilytettyä historiaa ohjelman kokoamana rajattuna
  kontekstina; se ei saa suoraa pääsyä tallennustiedostoihin.
- Käyttäjätietojen vienti ja palautus rajataan myöhemmäksi.
- Testien sijoittelu seuraa EKYn periaatetta: yksikkö-, komponentti- ja
  moduulikohtaiset integraatiotestit lähteen viereen, laajat integraatiotestit,
  E2E, malliarvioinnit ja yhteinen apuaineisto tests/-puuhun.
  Tämä korvaa aiemman kaikkien testien varjorakenteen. Testit ajetaan
  paikallisesti ilman GitHub-/etä-CI:tä.
- Kehityksessä pääkehittäjä vastaa toteutuksesta ja erillinen tarkastaja
  kriittisten toteutusmuutosten katselmuksesta. Tarkat vastuut omistaa
  [työohje](AGENTS.md#kehitystyön-roolit-ja-katselmus).
- Tähtiapurilla on oma julkinen [GitHub-repo](https://github.com/Antsa46/tahtiapuri).
  Issue omistaa toteutustehtävän ja Projects toimii työjonon näkymänä.
  Käyttötapaukset ja pysyvät ohjeet säilyvät repositorion docs/-puussa.
  Projectsia tukevan kehitysyhteyden käyttöönotto on erillinen työ.
- EKY on tämän projektin työssä vain luettava vertailukohde.
- Tähtiapurissa harjoitellaan yhteistä kehitystapaa. Oppien siirtäminen
  muihin projekteihin arvioidaan erikseen niiden omien tavoitteiden mukaan.

Nämä linjaukset eivät valitse kirjastoversioita tai hyväksy asennuksia.

## Sovittu ensimmäisen version rajaus

[Rajaus](docs/product/project-definition.md) kattaa paikallisen illan katsauksen,
keskustelun, kartan ja kohdetiedot sekä erillisen pilvisyysennusteen päivityksen.
Kartta, laskenta ja kielimalli suunnitellaan toimimaan ilman internetiä.
Tuoreen sääennusteen haku käyttää rajattua ulkoista APIa; muut havaintokäytön
osat eivät saa ulkoista verkkolupaa.

## Ehdotukset ja avoimet valinnat

| Asia | Tilanne |
| --- | --- |
| Uuden projektin aloituskäytäntö | Kymmenen kohtaa on käsitelty päälinjojen tasolla. Ensimmäinen [skilliluonnos](docs/ai/skills/task-start-finish/SKILL.md) on kirjoitettu projektin dokumentteihin. Käytännön kokeilu ja käyttöönotto ovat tekemättä; yhteistä skilliä ei ole asennettu eikä EKYä muutettu. |
| Tehtävien seuranta GitHubissa | Käyttäjä loi ja vahvisti julkiseksi repon [Antsa46/tahtiapuri](https://github.com/Antsa46/tahtiapuri). Suunnittelutiedostojen ja issueiden ensisiirto on valmistelussa. Projects-taulua ei ole luotu; nykyinen GitHub MCP ei tarjoa sen luontia. Etä-CI:tä ei lisätä. |
| Sovellusjako | [Vaihtoehto A](docs/architecture/base-architecture.md#vaihtoehto-a-kevyt-ekyn-mukainen-workspace) on valittu pohjaksi: apps/web, apps/desktop, apps/backend ja kolme rajattua yhteistä pakettia. B säilyy arvioituna vaihtoehtona. |
| Paikallinen backend | Sovittu perusmalli: backendin assistant-moduulin ohjelmakoodi koordinoi rajattuja mallirooleja; omistavat moduulit tarkistavat toiminnot. Mallin laskenta on erillisessä prosessissa. Tarkat sopimukset ovat avoinna [työnkulkusuunnitelmassa](docs/architecture/assistant-orchestration-plan.md). |
| Desktopin ja backendin yhteys | Sovittu suora IPC mainin ja backendin välille. Renderer–main pysyy rajattuna Electron IPC:nä. [HTTP/IPC-vertailu](docs/architecture/base-architecture.md#paikallinen-http-vai-suora-prosessikanava) säilyy perusteluina; tarkka viestisopimus ja toteutustekniikka täsmennetään ennen koodia. |
| Ensimmäinen kohdejoukko | Kuu ja planeetat kohdetietoineen sekä tähtikartan paikallinen tähtiaineisto. Tarkka katalogi avoinna. |
| Tähtikartan sovitin | D3-Celestial on ensisijainen arvioitava vaihtoehto; tarkkaa versiota tai aineistopakettia ei ole hyväksytty tai asennettu. |
| Havaintopaikka ja horisontti | Sovittu: muutama paikallisesti säilyvä nimetty paikka ja omat koordinaatit, yksi aktiivinen kerrallaan. Käynnistys muistaa viimeksi käytetyn paikan. Tallennusmuoto, paikan poistaminen ja horisonttiesteet avoinna. |
| Kiikareiden ja kaukoputken tiedot | Tarkat ominaisuudet ja niiden käyttö suosituksissa selvitetään myöhemmin. |
| Tähtilaskennan sovitin | Astronomy Engine on ehdokas, ei vielä hyväksytty tai asennettu riippuvuus. |
| Mallin kehitysrajapinta | Sovittu paikallinen stdio-MCP ja asetusten kehitysyhteyskytkin ensimmäiseen mallikokeeseen. [Kytkin ja sulkeminen](docs/architecture/local-model-plan.md#kehitysyhteyden-kytkin) rajaavat yhteyden käyttökertaan. SDK/versio, backendin IPC, todentaminen ja eristys ovat avoinna. |
| Mallimoottori ja mallipaketit | Sovittu suunta: Poro–Ministral-vertailu, 4B-kokoluokan lisäys, asetusten mallinvaihto ja painot erillisessä paikallisessa kansiossa. Qwen3:n 4B/8B/14B sekä 14B:n IQ3_M- tai Q3_K_M-koe ovat ehdotuksia; Q4_K_M säilyy vertailukohtana. llama.cpp on moottoriehdokas turva-arvion rajoilla. Tarkat tiedostot, moottoribuild ja oletusmalli ovat avoimia. |
| Sää ja eristys | Ilmatieteen laitos on valittu tarjoajaksi; WFS ja HARMONIE (MEPS) ovat tekninen lähtöehdotus. Tarkka kysely ja käyttöjärjestelmän eristys avoinna. Open-Meteoa ei toteuteta rinnalle. |
| UI-, testi- ja paketointityökalut | React/Vite ja oma CSS Modules on hyväksytty suunta. [Tekniikkaehdotuksessa](docs/architecture/technology-and-ui-plan.md) Vitest/Playwright ovat edelleen ehdokkaita. IPC-backendille ei lisätä Honoa tai muuta HTTP-frameworkia. Versiot ja paketointi avoinna; testaus paikallisesti. |
| Keskusteluhistoria ja tallennus | Sovittu paikallinen historia säilyy käyttäjän poistoon asti. Yksittäinen keskustelu tai koko historia voidaan poistaa; säilytettyä historiaa käytetään rajattuna mallikontekstina. [Tiedon elinkaari](docs/architecture/data-lifecycle-plan.md) omistaa tarkat haku-, poisto-, formaatti- ja palautussopimukset. |
| Vienti ja palautus | Rajattu myöhemmäksi; ei ensimmäiseen versioon. Paikallisen tallennuksen eheysvaatimukset säilyvät [tiedon elinkaaren](docs/architecture/data-lifecycle-plan.md) mukaan. |
| Havaintopäiväkirja | Myöhempi laajennus. Ensimmäinen tekninen koe voi olla muistissa, mutta sovitut havaintopaikat tarvitsevat ensimmäisessä käyttöversiossa pysyvän tallennuksen. |

## Jatka tästä

Koko projektin [roadmap](docs/planning/roadmap.md) sisältää vaiheet P0–P5,
jatkokokeen E1 sekä käyttötapausten UC-01–UC-08 jäljitettävyyden.
[Kehitysmallien työnjako](docs/ai/development-models.md) on tehtäväkohtainen
suositus, jota ei ole vielä verrattu omilla kehitystehtävillä.
Erillisiä malliasetuksia ei ole muutettu.

Ensimmäinen toteutusta edeltävä työpaketti on T01: tarkat 4B/8B-painot,
moottoriversio, koeympäristö ja oikeudet sekä pieni arviointiaineisto
ja hyväksymisehdot. Ensimmäinen näyttö on sovittu
[rajattu mallikoe](docs/ai/testing-rules.md#ensimmäinen-tekninen-hyväksymiskoe)
ennen käyttöliittymän viimeistelyä. node-llama-cpp:tä arvioidaan
UtilityProcessissa; GGUF-painot ovat asentimen ulkopuolisessa kansiossa.

Ajotavan valinta ei todista verkko- tai tiedostorajaa. Vain säätyöntekijän
sovittu verkkoyhteys, MCP:n suljettu oletustila ja yksityisen aineiston
rajat säilyvät. Käyttöliittymän kartta ja yksi yhteinen käynnistyskatsaus
pysyvät ensimmäisen käyttöversion tavoitteina.

Skilliluonnoksen käytännön hyöty arvioidaan yhdessä rajatussa tehtävässä.
Mallivalinnan ja mallikansion muistaminen ovat edelleen avoimia.
Sovelluskoodi, asennukset ja mallilataukset alkavat vasta erillisestä
toteutuspyynnöstä. EKYn tiedostoja tai mallivalintaa ei muuteta tässä.
