# Yhteinen kehitystapa ja uuden projektin aloitus

Tämä ohje kokoaa yhtenäisen suunnittelun, toteutuksen ja ylläpidon tavan.
Alla olevat kymmenen aloituskohtaa ovat ehdotus tämän toteuttamiseksi.
Projektikohtaiset vastaukset sovitaan erikseen.

Tätä mallia harjoitellaan ensin Tähtiapurissa. Siirtäminen muihin projekteihin
arvioidaan niiden omien tavoitteiden ja käytäntöjen pohjalta.
Tämä kirjaus ei muuta vertailuprojektin ohjeita tai toteutusta.

## Yhteinen työtapa

Tavoite -> hyväksymisehdot -> käyttötapaukset ja olennaiset haarat ->
vaihtoehtojen arviointi -> pienet toteutusvaiheet -> tuloksen tarkistus.

Suunnittelussa kysytään yksi olennainen päätös kerrallaan ja annetaan
perusteltu suositus. Tekniset faktat selvitetään lähteistä ja kokeista.
Haaran tila on sovittu, avoin, kokeella selvitettävä tai myöhemmäksi rajattu.
Uusi näyttö voi avata aiemman päätöksen uudelleen.

Yhteiset skillit voivat myöhemmin ohjata toistuvia työtapoja.
AGENTS.md omistaa projektin työrajat ja lukureitin; aihedokumentit
projektikohtaiset sopimukset. Historiallinen aineisto erotetaan nykyisistä
ohjeista. Projektikohtaisten skilliluonnosten ja käyttöönoton tila
kirjataan projektin päätöshakemistoon, ei tähän yhteiseen aloituslistaan.

## Tehtävien, ohjeiden ja tarkistusten työnjako

Alla kuvataan tehtävien ja pysyvien ohjeiden työnjako. Projektikohtaisen
käyttöönottopäätöksen, ajoituksen ja avoimien oikeuksien omistaja on
[päätöshakemisto](../planning/decisions.md). Tarkat tehtäväkentät ja tarkistukset ovat
edelleen täsmennettäviä ehdotuksia.

| Väline | Vastuu |
| --- | --- |
| Git | Tiedostojen versiot ja muutosten vertailu. |
| GitHub Issue | Yhden työn tavoite, rajaus, hyväksymisehdot, tilanne ja valmistumisen näyttö. |
| GitHub Projects | Issueiden ja PR:ien yhteinen työjono, prioriteetti ja etenemisnäkymä. |
| AGENTS.md | Lyhyet pysyvät työrajat ja tehtäväkohtainen lukureitti. |
| docs/ | Arkkitehtuuri, moduulien sopimukset, perustelut ja käyttöohjeet. |
| Paikalliset tarkistukset | Sovittujen lähde-, testi- ja moduulirajojen koneellinen valvonta sekä toiminnalliset testit. |

GitHubia käytettäessä avoimen tehtävän omistaja on issue. Projectsin näkymä
ei ole toinen tehtäväkuvaus, eikä samaa tehtäväjonoa ylläpidetä docsissa.
Issue linkittää pysyviin ohjeisiin; siinä ei kopioida koko sääntökirjaa.
README näyttää projektin yleisen vaiheen ja linkin työjonoon.
[GitHubin Projects-ohje](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects)
kuvaa issueiden ja PR:ien yhteisen näkymän.

Ehdotettu pieni kokeilu on yksi rajattu työ: issue → toteutusrajauksen ja
ohjeiden luku → pieni muutos → paikalliset tarkistukset → katselmus →
valmistumisen näyttö issueen. GitHub-seuranta ei edellytä etä-CI:tä.
Repositoryn näkyvyys ja julkaistava sisältö päätetään ennen etäkirjoituksia.
Paikallinen polku, käyttäjäaineisto tai koko keskusteluhistoria ei kuulu
issueen automaattisesti.

Issueen ehdotetaan tavoitetta, sallittuja muutosalueita, omistavien ohjeiden
linkkejä, hyväksymisehtoja ja tarvittavaa testinäyttöä. Uuden kansioperheen
tai riippuvuuden tarve tunnistetaan rajauksessa. Myöhempi muutos kirjataan
ennen siihen perustuvaa toteutusta.

Tehtävätaulu ei pakota koodia noudattamaan sovittua rakennetta.
Tähtiapurissa voidaan toteutusvaiheessa tehdä paikallinen tarkistus
testiperheiden sijoittelusta, yhteisestä tests/-puusta, apuaineistoista
ja moduulirajoista.
[Testausohje](testing-rules.md) omistaa tarkat sijaintisäännöt.
Skill voi ohjata toistuvan työn aloitusta ja lopetusta; se ei korvaa
koneellista tarkistusta tai katselmusta. Yhden kokeen tulos arvioidaan
ennen työtavan laajentamista.

## Kymmenen kohtaa ennen ensimmäistä toteutusta

1. **Käyttäjä, tarkoitus ja tavoite.**
   Kenelle ohjelma tehdään, minkä tarpeen se täyttää ja mikä näkyvä tulos
   osoittaa ensimmäisen vaiheen onnistumisen? Erota käyttäjähyöty ja
   mahdollinen oppimis- tai tutkimustavoite.

2. **Ensimmäisen version rajaus ja työalue.**
   Mikä on pienin hyödyllinen kokonaisuus, mitä jätetään myöhemmäksi ja
   millaiset aika-, kustannus- ja laiterajat vaikuttavat siihen?
   Varmista oma projektikansio, muutettavat alueet ja vertailuprojektien rajat.

3. **Käyttötapaukset ja poikkeukset.**
   Kuvaa käyttäjän tavoite, syötteet, tavallinen kulku, puuttuva tieto,
   keskeytys ja tärkeät virhetilanteet. Liitä kuhunkin havaittava
   hyväksymisehto. Ratkaisemattomat haarat kirjataan näkyviin.

4. **Arkkitehtuuri ja vastuiden omistajat.**
   Sovi käyttöliittymän, runtimen, backendin, domainin ja sovittimien vastuut
   sekä moduulien julkiset rajat ja riippuvuussuunta.
   Valitse projektin tarpeisiin sopiva laajuus; jokainen moduuli ei vaadi
   omaa prosessia tai pakettia.

5. **Tiedon elinkaari ja palautettavuus.**
   Mitä tietoa säilytetään, missä on sen luotettu alkuperä ja mikä osa on
   välimuistia? Sovi tarpeen mukaan säilytys, poisto, vienti,
   varmuuskopiointi, palautus ja formaattimuutosten käsittely.
   Jos ensimmäinen koe ei säilytä käyttäjädataa, kirjaa se.

6. **Luottamusrajat ja käyttöoikeudet.**
   Tunnista ulkoiset syötteet ja se, kuka saa lukea, kirjoittaa, käyttää
   verkkoa tai suorittaa työkaluja. Sovi validointi, salaisuuksien käsittely,
   lokien tietosisältö ja projektin tarvitsemat eristysrajat.
   Mallin antama ohje ei muuta ohjelman valvomia oikeuksia.

7. **Teknologiat, riippuvuudet ja toimitus.**
   Perustele runtimet, kirjastot ja ulkoiset palvelut. Selvitä lisenssit,
   ylläpito, versioiden hallinta ja vaihdettavuus sekä se, miten käyttäjä
   asentaa ja päivittää ohjelman. Mallia käytettäessä arvioi myös moottorin
   ja mallipainojen jakelu. Avoin kokeilu erotetaan hyväksytystä valinnasta.

8. **Testaus ja valmistumisen näyttö.**
   Sovi testien sijainti, tarvittavat tasot, synteettinen aineisto ja
   ensimmäisen käyttäjäpolun hyväksymiskoe. Huomioi virheestä palautuminen
   sekä tarpeen mukaan oikea malli, verkkorajaus ja paketoitu sovellus.
   Tähtiapurin tarkka käytäntö on [testausohjeessa](testing-rules.md).

9. **Työnkulku, roolit ja päätösvalta.**
   Jaa roadmap pieniin tavoitteisiin ja nimeä niiden hyväksymisehdot.
   Sovi tässä kehityksen GPT-mallien tehtäväjako ja päättelytason valinta.
   Sovelluksen paikalliset mallit ja niiden ajotapa kuuluvat kohtaan 7.
   Sovi ihmisen, kehitysagenttien ja sovelluksen ajonaikaisten agenttien
   roolit sekä katselmuksen, riippuvuuspäätösten ja julkaisemisen käytäntö.
   Rajatun tehtävän lupa ei itsessään laajenna työaluetta tai ulkoisia toimia.

10. **Ohjeiden ja yhteisten käytäntöjen ylläpito.**
    Anna sopimukselle yksi omistava dokumentti ja linkitä siihen muualta.
    Sovi nykytilan, historian ja avoimien päätösten paikat.
    Tee skill toistuvasta työtavasta, kun sen hyöty voidaan osoittaa;
    paranna olemassa olevaa ohjetta ennen rinnakkaisen ohjeen lisäämistä.

## Miten listaa käytetään

Käy jokainen kohta läpi aloituksessa, mutta täsmennä se seuraavan
toteutuspalan vaatimaan tarkkuuteen. Vastaus voi olla myös ei koske tätä
projektia tai nimetty kokeella selvitettävä asia. Kokeelle kirjataan kysymys,
onnistumisen ehto ja se, mihin päätökseen tulos vaikuttaa.

Toteutusta estävä avoin kysymys ratkaistaan ennen siitä riippuvaa toteutusosaa.
Riippumaton suunnittelu ja kokeilu voivat jatkua tehtävän rajojen sisällä.
Projektikohtaisia vastauksia ei kopioida tähän yleiseen listaan:
Tähtiapurin esittely on [READMEssä](../../README.md), valintojen tila
[päätöshakemistossa](../planning/decisions.md) ja aihekohtaiset sopimukset
[lukureitin](../README.md) osoittamissa dokumenteissa.

## Rakennemallin nimitys

Suunnitellun arkkitehtuurin tiivis kuvaus on
**local-first modulaarinen monoliitti, jossa on sipuliarkkitehtuurin kerrokset**.
Moduulit jakavat toiminnalliset vastuut; domain pysyy teknologioista
riippumattomana ja ulkoiset tekniikat ovat porttien ja sovittimien takana.

Rakennetta voi kuvata sipuli- ja puumallin yhdistelmänä:
sipuli kuvaa kerroksia ja puu toiminnallisia moduuleja.
Monorepo kuvaa sovellusten ja pakettien järjestämistä samaan repositorioon;
Electron kuvaa desktop-runtimea. Kehitystapaa kuvaa vaiheittainen työ
pienillä pystysuorilla toteutuspaloilla.

Tämä on suunnitellun rakennemallin nimitys, ei jokaisen tiedoston
vaatimustenmukaisuuden arvio. Tähtiapurin vastuut
omistaa [perusarkkitehtuuri](../architecture/base-architecture.md).
