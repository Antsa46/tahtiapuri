# Tekniikkaehdotus ja käyttöliittymän linja

Tila: kohdan 4 suunnitteluehdotus, kirjattu 2.11.2026.
Käyttäjän vahvistama tavoite on säilyttää EKYn kaltainen tekninen rakenne,
jotta Tähtiapuri toimii paikallisen mallin ja agenttiohjauksen pilottina.
React/Vite ja oma CSS Modules -tyylitys on hyväksytty tekniseksi suunnaksi.
Täsmäversiot, asennukset ja muut alla nimetyt uudet kirjastot eivät vielä
ole hyväksyttyjä riippuvuuksia.
[README](../../README.md) omistaa päätösten tilan ja jatkamiskohdan.

[Perusarkkitehtuuri](base-architecture.md) omistaa kerrokset, moduulit ja
luottamusrajat. Tämä dokumentti omistaa käyttöliittymätekniikan vertailun ja
alustavan riippuvuuskartan. Tarkat versiot, lisenssit, toimitusketju ja
hyväksyntä käsitellään aloituslistan kohdassa 7 ennen käyttöönottoa.

## Valitun tekniikan perustelu

React ja TypeScript jäsentävät kartan, keskustelun ja asetusten
käyttöliittymätilat. Vite on kehityksen ja paketoinnin työkalusuunta;
oma CSS Modules -tyylitys pitää ulkoasun hallittavana.

Electron omistaa desktopin elinkaaren. Backend ja puhtaat domain- sekä
validation-paketit pitävät havaintosäännöt erillään käyttöliittymästä ja
moottorisidoksista. Main–backend-yhteys käyttää sovittua IPC:tä.
Täsmäriippuvuudet ja toimivuus varmennetaan Tähtiapurin omissa kokeissa.

## Käyttöliittymävaihtoehdot

| Vaihtoehto | Hyöty | Vaikutus tähän pilottiin |
| --- | --- | --- |
| HTML, CSS ja TypeScript ilman komponenttikirjastoa | Suora DOM-toteutus riittää hyvin pieneen näkymään. | Keskustelun, karttavalinnan, keskeytyksen ja rinnakkaisten tilojen hallinta jää omaksi työksi. Poikkeaa EKYn React-rakenteesta. |
| React, TypeScript, Vite ja oma CSS Modules | Sama UI-tekniikka kuin EKYssä; näkymät ja tilat voidaan jakaa komponenteiksi. | Hyväksytty yleinen suunta. Ulkoasu suunnitellaan Tähtiapurille; täsmäversiot päätetään erikseen. |
| React ja erillinen UI- tai tyylikirjasto | Valmiit komponentit tai tyylityksen käytännöt voivat vähentää omaa toteutustyötä. | Arvioidaan nimetyn komponenttitarpeen perusteella. Teemat, saavutettavuus, riippuvuudet ja ylläpito pitää silti tarkistaa. |

React omistaa näkymien kokoamisen ja tilaan perustuvan esityksen.
Vite on kehitys- ja rakennustyökalu. Kumpikaan ei valitse sovelluksen
visuaalista tyyliä. CSS Modules on Viten tukema tyylien rajaustapa;
sen vuoksi ei tarvita erillistä UI-kirjastoa.

Suositus on tumma, rauhallinen karttatyöpinta: kartta pääalueena, keskustelu
rinnalla, kohdetiedot valinnan yhteydessä sekä paikka ja käytetty aika näkyvissä.
Kontrasti, näppäimistökäyttö ja tilaviestit kuuluvat suunnitteluun.
Havaintokäytön erillinen punainen yötila voidaan arvioida myöhemmin;
sitä ei lisätä huomaamatta ensimmäisen version vaatimukseksi.

Mahdollisia webin featureitä ovat sky-map, assistant ja settings.
Niiden lopullinen jako seuraa todellista vastuuta. App kokoaa julkiset
feature-entrypointit. Karttakirjasto on oman piirtoadapterin takana:
React hallitsee sovittimen säiliötä ja elinkaarta, sovitin omaa piirtoaluettaan.
Kartan päivitys ei saa luoda koko karttamoottoria uudelleen jokaisesta viestistä.

Yhteiset värit, välit ja typografia määritellään pienellä CSS-muuttujajoukolla.
Komponenttien tyylit ovat omissa viereisissä .module.css-tiedostoissaan.
Yksikkö- ja komponenttitestit ovat lähteen vieressä.
Laajojen testien ja yhteisen apuaineiston sijainnin omistaa
[testausohje](../ai/testing-rules.md).
Jaettu webin sisäinen UI-osa erotetaan vasta todellisesta toistosta.
packages/ui-pakettia ei perusteta yhden rendererin vuoksi.

## Alustava riippuvuuskartta

Taulukko kuvaa tarkoitusta ja sijoittelua, ei valmista asennuslistaa.
Yksi rivi voi sisältää useita paketteja ja transitiivisia riippuvuuksia.

| Osa | Ehdokas tai suunta | Sijoittelu ja peruste |
| --- | --- | --- |
| Desktop-runtime | Electron; suunta on jo sovittu | apps/desktop: ikkunat, prosessit, resurssit ja valvottu IPC. |
| Käyttöliittymä | React ja React DOM | Vain apps/web; EKYn tekniikka ja keskustelun sekä kartan tilallinen UI. |
| UI:n rakennus | Vite ja React-plugin | Kehitykseen ja rakentamiseen. Paketoitu ohjelma ei tarvitse Vite-palvelinta. |
| Kieli ja tyypit | TypeScript sekä tarvittavat @types-paketit | Tyypintarkistus erikseen; Viten muunnos ei yksin tarkista tyyppejä. |
| Paikallinen backend | Node/TypeScript ja rajattu IPC-adapteri | Node Electronin hallitsemassa prosessissa. Main–backend-kuljetus on sovittu IPC:ksi, joten Honoa tai @hono/node-serveriä ei tarvita tähän yhteyteen. Sovelluksen käyttäjältä ei edellytetä Node-asennusta. |
| Taivaan laskenta | Astronomy Engine | Backendin sky-laskentasovitin; oma laskenta- ja koordinaattisopimus säilyy. |
| Kartan piirto | D3-Celestial ja sen tarvitsemat paikalliset resurssit | Rendererissä rajatun karttasovittimen takana. D3-yhteensopivuus, lisäriippuvuudet ja aineistojen oikeudet tarkistetaan ennen valintaa. |
| Mallimoottori | llama.cpp / llama-server | Erillinen hallittu natiiviprosessi. Oma mallisovitin; ei sovelluksen agenttikehystä. |
| Mallin painot | Vaihdettavia GGUF-malleja erillisessä paikallisessa kansiossa; yksi muistissa kerrallaan | Mallikansio ja 4B/8B/14B-vertailu kuvataan [mallisuunnitelmassa](local-model-plan.md). Painot eivät kuulu tavalliseen sovellusbuildiin. |
| Sääpalvelu | Ilmatieteen laitoksen avoin data; tarjoaja on sovittu | Yksi tarjoajasovitin rajatussa säätyöntekijässä. HTTP:n perustoteutukseen arvioidaan ensin runtimen valmiit API:t; SDK ei ole oletustarve. |
| Rajapintojen validointi | Omat pienet validaattorit tai erikseen perusteltu skeemakirjasto | packages/validation ja käyttötapauksen omat tarkistukset. TypeScript-tyyppi ei validoi ulkoista JSONia ajossa. |
| Testaus | Vitest; Playwright tarvittaville UI-/desktop-poluille | Kehitysriippuvuuksia. Playwrightin Electron-tuki on kokeellinen; paketoidun sovelluksen hyväksyntä ei nojaa vain siihen. |
| Työtila ja rakennus | pnpm-workspace on EKYn mukainen ehdokas | Lukittu työkaluketju, vain tarpeelliset paketit. Linttaus, formatointi ja tarkat komennot täsmennetään. |
| Paketointi ja jakelu | Electronin paketointi- ja suojaustyökalut arvioidaan EKYn kokemusten pohjalta | Arvioidaan muun muassa @electron/packager, @electron/asar ja @electron/fuses tarpeen mukaan. Asennin ja päivitysratkaisu päätetään erikseen. |

Sovelluksen mukana toimitettava koodi ja resurssit erotetaan vain
kehityksessä tarvittavista työkaluista. Electron kuuluu toimitettavaan
runtimeen, vaikka sen npm-paketti merkittäisiin devDependencies-kohtaan.
Myös upotetut ja transitiiviset kirjastot sekä katalogit, fontit, mallipainot
ja GPU-taustan lisäkirjastot kuuluvat toimituksen riippuvuusselvitykseen.

## Sääpalvelun alustava vertailu

Käyttäjä valitsi Ilmatieteen laitoksen avoimen datan sääpalveluksi.
Tekninen suositus on sen WFS-piste-ennuste; lähtöehdokas on HARMONIE (MEPS).
Palvelu toimittaa ennusteen: ohjelmassa ei ajeta numeerista säämallia.
HARMONIE (MEPS) on HARMONIE-AROME-pohjainen pohjoismainen järjestelmä,
jonka FMI:n nykyinen kuvaus ilmoittaa 2,5 km:n hilalle ja 66 tunnin jaksolle.
Tämä on soveltuvuusarvio, ei mitattu pilvisyystarkkuuden paremmuusvertailu.
[Lähde](https://www.ilmatieteenlaitos.fi/avoin-data-saaennustedata-hirlam)

| Lähde | Avaimet ja käyttö | Integraation vaikutus |
| --- | --- | --- |
| Ilmatieteen laitoksen avoin WFS | Ei API-avainta tai rekisteröitymistä; maksuton CC BY 4.0 -aineisto, lähde ja aineisto nimettävä sekä hakurajoja noudatettava. | XML-pohjainen piste-ennuste. Sovitin muuntaa sen omaan tietomalliin. Tarjoaja on sovittu; kysely täsmennetään. |
| Open-Meteo | Ilmainen avaimeton API henkilökohtaiseen ei-kaupalliseen käyttöön; kutsurajat. Maksullisen kaupallisen palvelun ehdot erikseen. | JSON-vastaus; vaihtoehto, jos FMI:n tietosisältö tai sovitettavuus ei riitä. Ei automaattista toista verkkokohdetta alkuun. |

Ilmatieteen laitoksen dokumentoima WFS-kyselyperhe sisältää HARMONIE-pisteen
multipointcoverage- ja timevaluepair-muodot. Valittu kysely, parametrit,
pilvisyyden yksiköt, puuttuvan arvon esitys ja käytettävä ennustejakso
varmistetaan ennen sovittimen toteutusta.
[Latauspalvelun ohje](https://www.ilmatieteenlaitos.fi/latauspalvelun-pikaohje)

Ensimmäisen sääpalasen tavoitteena ovat tuntikohtainen kokonaispilvisyys,
lämpötila, kosteus, tuuli ja sateen tieto. Kerrospilvisyys ja näkyvyys
otetaan mukaan vain, jos valittu kysely palauttaa ne määritellysti.
Kokonaispilvisyyttä ei tulkita selkeän sään todennäköisyydeksi tai seeingiksi.
Puuttuva tai vanhentunut tieto säilyy näkyvästi sellaisena.

XML-jäsennin arvioidaan erillisenä riippuvuutena: ulkoisten entiteettien,
DTD:n ja verkosta haettavien skeemojen käyttö estetään. Vastauksen URL-viitteitä
ei seurata automaattisesti. Verkko- ja käyttöoikeuspolitiikan omistaa
[perusarkkitehtuuri](base-architecture.md); avaimeton API tarvitsee samat rajat.

- [FMI:n avaimeton käyttö](https://www.ilmatieteenlaitos.fi/ajankohtaista/963113497)
- [FMI:n lisenssi ja palvelun käyttöehdot](https://www.ilmatieteenlaitos.fi/avoin-data-lisenssi)
- [Open-Meteon nykyiset palveluehdot ja rajat](https://open-meteo.com/en/pricing)
- [Open-Meteon API-kuvaus](https://open-meteo.com/en/docs)

## EKYlle siirtyvä kokeen tulos

Pidetään ohjelmakohtainen taivaslogiikka erillään seuraavista vastuista:

- mallisovitin ja moottorin käynnistys, tilat ja sulku
- rajattu konteksti, työjono, peruutus, aikakatkaisu ja tokenirajat
- backendin tarkistamat työkalupyynnöt ja oikeudet
- kehitys- ja diagnostiikkarajapinnan malli
- toistettavat malliarvioinnit ja paketoidun offline-ajon todisteet.

Nämä ovat mahdollisia siirrettäviä sopimuksia ja kokemuksia, eivät vielä
yhteisen ohjelmakirjaston toteutus. Tähtiapuri ja EKY eivät importoi toistensa
checkoutia. Yhteinen paketti arvioidaan vasta molemmissa todistetusta tarpeesta.
Useat agenttiroolit voidaan ensin toteuttaa samalla mallilla ja pienellä
eksplisiittisellä työnkululla. Yleistä agenttikehystä ei tarvita alkuun.

[Paikallisen mallin suunnitelma](local-model-plan.md) omistaa myös Codexin
sisäisen kehitysyhteyden. Käyttäjä valitsi suunnaksi paikallisen stdio-MCP:n.
SDK ja versio, backend-yhteys, todentaminen ja käyttöönotto ratkaistaan
ennen toteutusta. Kehitysyhteys ei anna paikalliselle mallille koodaus-
tai GitHub-oikeuksia.

## Avoimet päätökset ja rajaus

Kohdassa 4 sovitaan kerrokset ja riippuvuuksien sijoittelu sekä
käyttöliittymän yleinen tekninen suunta. Täsmäversiot, yhteensopivuus,
lisenssit ja hyväksytty asennuslista käsitellään kohdassa 7.

Pythonia, toista UI-frameworkia, pilvipalvelua, vektoritietokantaa,
ORM:ää tai ulkoista agenttikehystä ei lisätä ilman konkreettista tarvetta.
SQLite arvioidaan tiedon elinkaaren yhteydessä kohdassa 5; EKYn SQLite- ja
PDF-riippuvuudet eivät ole tämän harjoituksen lähtövaatimuksia.
Säätyöntekijän käyttöjärjestelmäeristys on avoin tekninen kysymys.
Prosessien erottaminen tai tietyn kirjaston valinta ei yksin todista eristystä.

## Tarkistetut ensisijaiset lähteet

- [React ja Vite-pohjainen sovellus](https://react.dev/learn/build-a-react-app-from-scratch)
- [Viten TypeScript- ja CSS Modules -tuki](https://vite.dev/guide/features.html)
- [Hono Node-ajossa](https://hono.dev/docs/getting-started/nodejs)
- [Electronin turvallisuusohje](https://www.electronjs.org/docs/latest/tutorial/security)
- [D3-Celestial](https://github.com/ofrohn/d3-celestial)
- [Astronomy Engine](https://github.com/cosinekitty/astronomy)
- [llama.cpp-palvelin](https://github.com/ggml-org/llama.cpp/tree/master/tools/server)
- [Vitest](https://vitest.dev/guide/)
- [Playwrightin Electron-tuki](https://playwright.dev/docs/api/class-electron)
