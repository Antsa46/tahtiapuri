# Tiedon elinkaari ja paikallinen tallennus

Tämä dokumentti omistaa käyttäjätiedon, historian ja välimuistien
tallennussopimuksen. Suunnittelun valinnat ja avoimet asiat kokoaa
[päätöshakemisto](../planning/decisions.md). T08 toteuttaa nimettyjen paikkojen JSON-tallennuksen. Sen formaatin,
kirjoituseheyden ja palautuksen omistaa [havaintopaikkojen toteutus](observing-places.md).
Muiden aineistojen tallennus on edelleen suunnitelma.

## Aineistot ja vastuut

| Aineisto | Omistaja | Säilyminen ja päätöksen tila |
| --- | --- | --- |
| Nimetyt havaintopaikat | observing | Sovittu: paikat ja koordinaatit säilyvät käynnistysten yli; käynnistys muistaa viimeksi käytetyn paikan. Käyttäjäpolun omistaa [UC-06](../product/observing-session-use-cases.md#uc-06-havaintopaikkojen-tallennus-ja-valinta). |
| Sovellusasetukset | observing | Sovittu: säähaun automaatti/manuaali-valinta säilyy käynnistysten yli. Ensimmäisen käynnistyksen oletus on manuaali. |
| Mallivalinta ja mallikansio | assistant | Sovittu suunta: valinta asetuksista, painot erillisessä paikallisessa kansiossa. Valinnan ja kansion säilyminen käynnistysten yli ovat avoimia; [mallisuunnitelma](local-model-plan.md#mallien-valinta-asetuksista) omistaa vaihtosopimuksen. |
| Keskusteluhistoria | assistant | Sovittu: paikallinen historia säilyy, kunnes käyttäjä poistaa sen. Yksittäisen keskustelun ja koko historian poisto tuetaan; malli voi hyödyntää säilytettyä historiaa rajattuna kontekstina. |
| Sääennuste | weather | Sovittu: viimeisin onnistunut ennuste säilyy havaintopaikoittain myös seuraavaan käynnistykseen. Lähde, paikka, ennusteaika, kattama ajanjakso ja noutoaika säilyvät mukana. |
| Lasketut taivastiedot | sky / planning | Ehdotus: lasketaan tarvittaessa uudelleen. Laskentatulos erotetaan käyttäjän tekemistä kirjauksista. |
| Tähtikatalogi ja moottori | Sovelluksen resurssit | Versioituja asennusresursseja, erillään käyttäjätiedosta. |
| Mallipainot ja malliprofiilit | assistant / mallisovitin | Painot ovat erillisessä paikallisessa mallikansiossa; profiilit kuvaavat hyväksytyt tiedostot. [Mallisuunnitelma](local-model-plan.md#paikallinen-mallikansio) omistaa käytön ja hankinnan. Sovelluksen tai keskusteluhistorian poisto ei poista ulkoisia mallipainoja. |
| Havaintopäiväkirja | Myöhempi laajennus | Rajattu myöhemmäksi. Keskusteluhistorian tallennus ei lisää erillistä havaintopäiväkirjaa ensimmäiseen versioon. |

## Viimeksi käytetyn paikan säilyminen

Käyttäjä valitsi 3.11.2026 viimeksi käytetyn havaintopaikan muistamisen.
Säilytetään tieto aktiivisesta nimetystä paikasta. Seuraavassa käynnistyksessä
sen nimi näkyy heti kartan yhteydessä, ja sama paikka ohjaa uusia laskentoja.
Jos kelvollista paikkaa ei ole, se valitaan ennen paikkasidonnaista katsausta.
Paikan palauttaminen ei lisää uusia säähaun käynnistystapoja.

## Sääasetuksen säilyminen

Käyttäjä valitsi 3.11.2026 hakutavan muistamisen ja ensimmäiselle
käynnistykselle manuaalitilan. Automaattihaku alkaa vain käyttäjän
valitseman ja tallennetun automaattitilan perusteella tai säähaku
käynnistyy erillisestä käyttäjän pyynnöstä. Malli ei muuta asetusta.
Tuntematon tai lukematta jäänyt asetus ei saa käynnistää automaattihakua.
Näkyvän toiminnan omistaa [UC-05](../product/observing-session-use-cases.md#uc-05-sääasetuksen-valinta).

## Sääennusteen välimuisti

Käyttäjä valitsi viimeisimmän onnistuneen ennusteen säilyttämisen kutakin
havaintopaikkaa kohti myös seuraavaa käynnistystä varten. Ennusteen ikä
ja kattama ajanjakso näkyvät; vanhaa ennustetta ei esitetä tuoreena.

Välimuisti palauttaa vain valittua paikkaa ja kysyttyä ajankohtaa koskevaa
tietoa. Paikan koordinaattien muuttuminen mitätöi vanhaan paikkaan sidotun
ennusteen käytön. Uusi validoitu ennuste korvaa vanhan; epäonnistunut haku
ei tyhjennä aiempaa onnistunutta ennustetta eikä myöhässä saapunut vanha
tulos korvaa tuoreempaa. Tarkka tuoreusraja sovitaan sääsovitinkokeessa.

Välimuistin puuttuminen tai vanheneminen ei käynnistä uutta API-hakua.
Säähaun käynnistystavat ja näkyvän saatavuuden omistaa
[UC-04](../product/observing-session-use-cases.md#uc-04-sääpäivitys).
Välimuisti on korvattavaa tietoa, ei keskusteluhistoriaa tai havaintopäiväkirjaa.

## Keskusteluhistoria ja mallin konteksti

Käyttäjä vahvisti paikallisen tallennuksen ja historian käytön mallin
keskustelukontekstina. Keskustelut säilyvät, kunnes käyttäjä itse poistaa ne;
automaattista aikaperusteista poistoa ei tehdä. Käyttäjä voi poistaa yhden
keskustelun tai koko historian. Näkyvä käyttäjäpolku on
[UC-07](../product/observing-session-use-cases.md#uc-07-keskusteluhistorian-käyttö-ja-poistaminen).

Backendin assistant-moduuli omistaa historian tallennus- ja hakukäyttötapaukset.
Mallille kootaan rajattu konteksti nykyisestä keskustelusta ja tarvittaessa
aiempien keskustelujen tarkoitukseen sopivista otteista. Malli käyttää
historian hakua vain ohjelman tarjoaman rajatun sopimuksen kautta.
Se ei saa suoraa tiedosto-, tietokanta- tai repositorypääsyä.
[Orkestrointisuunnitelma](assistant-orchestration-plan.md) omistaa työnkulun.

Historia ei ole mallipainojen koulutusta. Jokaisen mallipyynnön konteksti
kootaan erikseen; koko tallennettua historiaa ei syötetä jokaiseen pyyntöön.
Ensimmäiseksi arvioidaan yksinkertaista rajattua historian hakua.
Automaattiset yhteenvedot, vektorihaku ja pysyvä mallin oppiminen eivät
ole tämän päätöksen hyväksyttyjä lisäominaisuuksia.

Vanhan viestin ajankohta ja alkuperä säilyvät mukana. Sen sääennuste tai
taivaankappaleen sijainti ei muutu nykyhetken faktaksi. Aktiivinen paikka
ja aika tulevat sovelluksen luotetusta kontekstista; historiaviesti ei
vaihda niitä tai anna uusia työkaluoikeuksia.

Käyttäjä voi poistaa tallennetun keskustelun. Poisto estää sen käytön
uusissa historiahauissa ja mallille koottavassa kontekstissa.
Jo koottu konteksti tai keskeneräinen haku ei saa palauttaa poistettua
keskustelua käyttöön. Mahdollisten johdettujen tietojen ja poistamisen
tarkka toteutus sovitaan ennen niiden lisäämistä.
Poiston tekninen toteutus määritellään ennen tallennuksen toteutusta.
Historian poistaminen ei poista havaintopaikkoja tai asetuksia.

## Tallennuksen tekninen lähtöehdotus

Käyttäjän tiedot säilytetään paikallisessa käyttäjäkohtaisessa
sovellusdatahakemistossa, erillään lähdekoodista ja asennusresursseista.
Main omistaa validoidun datajuuren välittämisen. Backendin omistavat moduulit
käyttävät tallennusportteja; renderer tai malli ei kirjoita tiedostoja suoraan.
Testit käyttävät omaa synteettistä datajuurtaan.

Keskusteluhistoria erotetaan teknisestä lokituksesta. Yhteisiin lokeihin,
malliarviointien fixtureihin tai GitHub-tehtäviin ei kopioida oikeita
keskusteluja tai koordinaatteja. Diagnostiikan MCP-kokeet eivät saa historiaa
automaattisesti; kehitysyhteyden rajan omistaa mallisuunnitelma.
MCP-kytkimen päällä-tilaa ei palauteta tallennettuna asetuksena seuraavaan
käynnistykseen; kehitysistunnon elinkaaren omistaa
[kytkimen sopimus](local-model-plan.md#kehitysyhteyden-kytkin).

T08:n paikkaluettelo käyttää JSONia ilman uutta tietokantariippuvuutta.
Muiden aineistojen JSON-/SQLite-vaihtoehdot arvioidaan tietomäärän, hakujen
ja eheysvaatimusten perusteella. Hakukehystä tai salaustapaa ei ole valittu.

## Kirjoituksen eheys ja myöhempi vienti/palautus

Käyttäjä rajasi käyttäjätietojen viennin ja palautuksen myöhemmäksi.
Niitä ei toteuteta ensimmäiseen versioon. Mahdollisen myöhemmän toiminnon
sisältö, formaatti, yhteensopivuus ja salaus päätetään erikseen.


Tallennus saa ilmoittaa onnistumisen vasta sovitun pysyvyysehdon täyttyessä.
Keskeytys tai vioittunut tiedosto ei saa hiljaisesti tyhjentää aiemmin
tallennettuja paikkoja tai historiaa. Tarkka kirjoitus- ja yhteensopivuussopimus
tehdään ennen tallennusratkaisun toteutusta. Viennin ja palautuksen rajaus
myöhemmäksi ei poista nykyisen paikallisen tallennuksen eheysvaatimuksia.

## Avoimet valinnat ja todennettava toiminta

Kohdan 5 toiminnalliset päälinjat on sovittu. Paikkojen toteutettu formaatti sekä kirjoitus- ja poistosopimus ovat
[havaintopaikkojen ohjeessa](observing-places.md). Muiden aineistojen formaatti,
kirjoitus-/poistosopimus ja sääennusteen tuoreusraja ovat avoimia.
Tekniikat ratkaistaan kohdassa 7 ja testinäyttö kohdassa 8 ennen toteutusta.
Vienti ja palautus ovat myöhemmäksi rajattuja.

Toteutuksessa todennetaan paikallisesti ja synteettisellä aineistolla:
paikkojen, viimeksi käytetyn paikan ja historian säilyminen
uudelleenkäynnistyksessä, sääasetuksen ja paikkakohtaisen ennusteen
säilyminen, vanhan ennusteen tunnistaminen sekä tarkoitukseen
rajattu historian käyttö, poistamisen vaikutus myös valmiiksi koottuun
kontekstiin sekä keskeneräisestä kirjoituksesta palautuminen.
Vanha historia ei saa muuttaa nykyhetken laskentaa tai säähaun käynnistystapaa.
Testien sijainnin ja ajotavan omistaa [testausohje](../ai/testing-rules.md).
Nämä ovat tulevia hyväksymisehtoja, eivät ajettuja testejä.
