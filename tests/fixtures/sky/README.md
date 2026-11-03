# Riippumattomat tähtilaskennan vertailut

Paikat ja ajat ovat julkista **synteettistä koeaineistoa**.
Aikaleimat ovat tieteellisen havainnon ajankohtia, eivät koneen käyttölokeja.

## JPL Horizons

jpl-horizons.json sisältää 48 havaintoa, query-osoitteet ja alkuperäisvastausten
SHA-256:t. API vastasi versiolla 1.2; sarakkeet tarkistettiin vastauksista.
[Horizons API](https://ssd-api.jpl.nasa.gov/doc/horizons.html) kuvaa haun.

- QUANTITIES 2,4,9; apparent RA/Dec, paikallinen az/el ja visual magnitude.
- CENTER coord@399, GEODETIC; itäpositiivinen pituus, leveys, korkeus km.
- APPARENT AIRLESS, ANG_FORMAT DEG, EXTRA_PREC YES ja TIME_TYPE UT.
- TLIST sisältää vain fixturen havaintohetket. Paikat eivät ole käyttäjän paikkoja.
- RA/Dec ovat topocentriset tosiekvaattorin havaintohetken koordinaatit;
  horisontti ilman refraktiota. Paikkatoleranssi on 0,04°.
- Magnituditoleranssi 0,5. Saturnuksen magnitudia ei verrata eri rengas-/
  kiekkokirkkausmallin vuoksi; sijainti verrataan. Poikkeus kirjattiin
  ennen vertailutestien hyväksyntää.

Kehitysvaiheen haut tehdään sarjallisesti. Ohjelma ja tavalliset testit eivät
ota yhteyttä JPL:ään. Raakavastaukset säilyvät paikallisissa artefakteissa;
Gitissä on vain lähteistetty numeerinen vertailu.

## ERFA ja IANA

erfa.json poimii eraPn06a-, eraGst06a- ja eraHd2ae-vertailuarvot
[ERFA:n lähteestä](https://github.com/liberfa/erfa/blob/1a8044cde5b7763295d472a6443387239127c6c8/src/t_erfa_c.c).
ERFA pohjautuu IAU SOFAan; matriisi on IAU 2006/2000A -mallista.
Koetähdet ovat synteettisiä. Odotettua horisonttitulosta ei lasketa
testattavalla Astronomy Engine -sovittimella.

ERFA:n TT/UT1-viitepäivä käsitellään karkeassa vertailussa UTC-päivänä.
Pieni aika-/kehysbiasero sisältyy 0,04° toleranssiin.

Helsingin DST-odotukset perustuvat
[IANA tzdb-2024a europe -aineistoon](https://data.iana.org/time-zones/tzdb-2024a/europe):
EU:n maaliskuun ja lokakuun viimeinen sunnuntai klo 01 UTC.
Toistuva tunti ratkaistaan eksplisiittisellä offsetilla; puuttuva tunti hylätään.
