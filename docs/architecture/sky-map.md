# Paikallinen tähtikartta

Tämä dokumentti omistaa T07:n piirron, valinnan ja käyttöliittymän
havaintokontekstin. [Tähtilaskenta](sky-calculation.md) omistaa laskennan,
koordinaatit, aineiston ja tieteelliset rajat. [Turvallisuussuunnitelma](security-and-permissions-plan.md)
omistaa yleisen oikeusrajan. Paikkojen tallennuksen omistaa [observing](observing-places.md).

## Piirtoadapterin valinta

T07 kokeilee omaa rajattua Canvas 2D -sovitinta D3-Celestialin vaihtoehtona.
Canvas käyttää suoraan backendin laskemia korkeuksia ja atsimuutteja.
Se ei laske efemeridejä tai lataa omaa tähtikatalogia. React omistaa
näkymän tilan ja Canvas-adapteri oman piirtoalueensa, kuuntelijan ja sulun.
Tila päivitetään adapteriin; sitä ei rakenneta uudelleen keskustelun viesteistä.

D3-Celestialin luettu 0.7.35-package.json nimeää riippuvuudeksi D3 ^3.5.17;
sen ohje kuvaa erilliset D3-/projektiokirjastot ja JSON-karttaresurssit.
Se tarjoaa myös paljon tämän ensimmäisen näkymän ulkopuolisia ominaisuuksia.
Omaan rajattuun koko taivaan näkymään niitä ei vielä tarvita.
Canvas-vaihtoehdon valinta perustuu toteutettuun projektio-/valintakokeeseen
ja oikean Electronin käyttäjäpolkuun, ei D3-Celestialin ajettuun
suorituskykyvertailuun tai yleiseen turvallisuusväitteeseen.

Lähteet, luettu 3.11.2026:
[D3-Celestialin manifesti](https://github.com/ofrohn/d3-celestial/blob/master/package.json)
ja [käyttöohje](https://github.com/ofrohn/d3-celestial#usage).
D3-Celestialia, D3:a, niiden koodia tai katalogeja ei toimiteta tässä toteutuksessa.
Uusia ulkopuolisia riippuvuuksia ei lisätä. Piirtosovittimen voi vaihtaa
ilman backendin laskentasopimuksen muuttamista.

## Kartta, tarkkuus ja kohdevalinta

Näkymä on zeniittiin keskitetty atsimutaalinen tasavälinen projektio:

- Keskellä korkeus 90°, reunalla geometrinen horisontti 0°.
- Pohjoinen ylhäällä, itä vasemmalla, etelä alhaalla, länsi oikealla.
  Tämä on ylöspäin katsova tähtikartta. Kehät ovat korkeuksilla 30° ja 60°.
- Piirtosäde on `(90 − korkeus) / 90`; kulma on backendin atsimuutti.
  Koordinaateissa `x = −säde × sin(atsimuutti)`, `y = −säde × cos(atsimuutti)`.
- Horisontin alapuolisia kohteita ei piirretä. Niitä voi hakea ja valita
  luettelosta; kortti näyttää negatiivisen korkeuden selvästi.
- Zeniitissä määrittelemätön atsimuutti sijoitetaan keskelle. Muuta
  määrittelemätöntä suuntaa ei arvata. Nadiiri jää näkymän ulkopuolelle.
- Pisteen koko kuvaa magnitudia tai Aurinkokunnan kohdeluokkaa.
  Se ei ole oikea kulmaläpimitta, kuuvaiheen kuva tai fotometrinen simulaatio.
  Kartta näyttää kohteet myös päivänvalossa; päivänvalo ei hävitä katalogia.
- Piirto käyttää laskennan lukuja pyöristämättä. Kohdekortti näyttää
  korkeuden/atsimuutin 0,1°, deklinaation 0,01°, RA:n 0,001 h ja
  magnitudin 0,01 välein. Pyöristys ei lupaa vastaavaa havaintotarkkuutta.
  Ilmakehä, havaintopaikan esteet, sää ja käytännön havaittavuus eivät kuulu
  tähän geometriseen näkymään. Laskennan vertailutoleranssit ovat omistavassa ohjeessa.

Napsautus valitsee lähimmän piirretyn pisteen enintään 12 CSS-pikselin
päästä. Tyhjän taivaan napsautus ei luo kohdetta. Hakuluettelo tarjoaa
samat tunnisteet näppäimistöllä: ilman hakua Aurinkokunta, haulla tähdet
ja planeetat nimellä tai HYG-tunnisteella, enintään 100 tulosta kerrallaan.
Taustakuvana ei käytetä keksittyjä tähtiä tai ulkoista kuvaa.
Nimet ja lähdemerkinnät näytetään tekstinä, ei HTML:nä tai avattavina URL:eina.

## Ajan ja paikan käyttö

Ilman käyttäjän antamaa kelvollista havaintopaikkaa ei esitetä oletettua
paikkasidonnaista karttaa. T08:n asetuksista valittu tallennettu paikka
antaa nimen, koordinaatit, korkeuden ja aikavyöhykkeen. Käynnistys laskee
nykyhetken kartan; paikan vaihtaminen säilyttää viimeisimmän validoidun
karttapyynnön UTC-hetken ja vaihtaa paikallisen näyttöajan uuden vyöhykkeen mukaan.

Kartan aika annetaan paikallisena kellonaikana ja eksplisiittisenä
UTC-poikkeamana minuutteina; IANA-aikavyöhyke tulee valitusta paikasta. Domainin `resolveLocalTime` hylkää kesäajan
puuttuvan kellonajan ja ristiriitaisen poikkeaman. Syksyn toistuva kellonaika
erottuu poikkeamalla. Käytetty paikka, paikallisaika, vyöhyke ja poikkeama
näytetään palautetusta snapshotista. UTC-vuosiväli on 2000–2100.
Nyt käyttää paikallista järjestelmäkelloa; ±1 h siirtää UTC-hetkeä ja laskee
uuden paikallisen näyttöajan. Aika ei etene huomaamatta taustalla.

Kartan ajan muutos sekä tallennetun aktiivisen paikan muutos poistavat
vanhan kartan ja valinnan. Paikan asetusten tallentamaton luonnos ei muuta karttaa. Uusi snapshot hyväksytään
vain samaan pyyntöön ja kontekstiin. Kohdevalinnan myöhäinen vastaus ei saa
korvata uutta havaintokontekstia tai suljettua näkymää. AI-keskusteluun
kytkeminen, mallin automaattinen katsaus ja keskustelusta tulevat karttapyynnöt
ovat T11/T12:n työtä.

## Nimetty IPC ja resurssit

Preloadin `sky.snapshot(observation)` ja `sky.select({ observation, objectId })`
välittävät vain nimetyt karttakyselyt. Main tarkistaa oman ikkunan
pääkehyksen, tarkan argumenttimäärän ja syöteskeeman. Backend tarkistaa
istunnon, operaation, voimassaoloajan, duplikaatin ja syötteen uudelleen.
Kohde haetaan tarkistetun katalogin tunnisteesta samassa havaintokontekstissa.
Syntaktisesti oikea mutta puuttuva tunniste hylätään.

UI jonottaa vain uusimman paikkakontekstin käynnissä olevan karttapyynnön jälkeen.
Main ja backend sallivat kumpikin yhden karttakyselyn kerrallaan;
samalla heartbeat ja sulku säilyttävät kapasiteettinsa. Sulku estää
myöhäisen vastauksen. Backend pitää muistissa yhden laskentatuloksen ja
korvaa sen seuraavan kontekstin myötä; se ei kirjoita havaintopaikkaa levylle.
Vastaukset tarkistetaan kuljetuksessa ja UI-asiakkaassa: 5 079 yksilöllistä
kohdetta, oikeat yksiköt, yhtenäinen aika sekä lähdeviitteet ja rajatut tekstikentät.

Katalogin sijainti tulee backendin oman moduulin resurssipolusta. UI,
paikallinen malli ja MCP eivät voi antaa polkua, URL:ia tai lähteen koodia.
Renderer ei saa tiedostorajapintaa tai tähtikatalogin raakadataa.
Canvas ja tekstit käyttävät rakennettuja JS-/CSS-resursseja; CSP:n
`connect-src 'none'`, navigointirajat ja paikallisen protokollan JS/CSS-lista
säilyvät. UI:n paikallisuus ei ole backendin tai malliprosessin OS-eristysnäyttö.
MCP:n operaatiot eivät laajene tämän muutoksen mukana.

Katalogin puuttuminen tai eheysvirhe palauttaa `CATALOG_UNAVAILABLE` ilman
polkua tai poikkeustekstiä. UI näyttää virheen ja uusintapainikkeen.
Virheellinen aika/paikka hylätään, suljettu yhteys näkyy saatavuusvirheenä.
Piirtovirhe ilmoitetaan erikseen sekä alustuksessa että päivityksessä:
kohdeluettelo toimii edelleen.
Kartta ei tarvitse mallia tai verkkoa eikä niiden virhe estä laskentakortteja.

## Aineiston oikeudet ja näyttö

Kartta käyttää vain T06:n 5 070 tähden HYG 4.1 -johdannaista sekä
Astronomy Engine 2.1.19:n Aurinkokunnan kohteita. Lähde, tekijät,
CC BY-SA 4.0, rajaus/muunnos ja lähderevisio näytetään kartan aineistotiedoissa.
Alkuperäinen lisenssiteksti ja muunnostiedot ovat
[resources/catalogs](../../resources/catalogs/README.md)-puussa.
Uutta kuvastoa, fonttia, tähdistöviivoja tai lisäaineistoa ei toimiteta.

Kohdistetut testit kattavat suunnat, korkeudet, horisonttirajan, osumat,
UTC/DST:n, muuttuvan paikan, validoinnin, aikaleimat ja aineiston virheen.
Electron-kokeessa varmennetaan todellinen preload/main/backend-polku,
karttanapsautus, kohdeluettelo, ajan/paikan päivitys, kapea näkymä ja vain
paikalliset renderer-resurssit. Testiaineisto on synteettistä ja käyttää
samoja hyväksyttyjä koepaikkoja kuin T06.
Käynnistys, sulku ja muut muuttumattomat prosessirajat säilyvät olemassa olevissa
E2E-regressioissa. Oikeaa mallia tai sääpalvelua ei tarvita tähän kokeeseen.
