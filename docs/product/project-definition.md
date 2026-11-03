# Tähtiapurin tarkoitus ja tavoitteet

Tämä dokumentti omistaa projektin käyttäjäkuvan, käyttötarpeen, käyttäjä-
ja oppimistavoitteet sekä ensimmäisen version tuoterajauksen.
Projektin etenemisjärjestys on [roadmapissa](../planning/roadmap.md).
Aloituskierroksen runko on [aloituslistassa](../ai/project-start-checklist.md).

## Käyttäjä ja käyttötarve

Ensisijainen käyttäjä on projektin tekijä itse. Hänellä on tähtitaivaan
perustiedot jo hallussa ja hän harrastaa havainnointia paljain silmin,
kiikareilla ja kaukoputkella. Välineiden tarkat ominaisuudet ovat avoinna.

Käyttäjä haluaa kokeilla keskustelevaa paikallista tähtiavustajaa.
Apuri tuntee sovelluksessa käytetyn havaintopaikan ja illan taivaan
tilanteen. Käynnistyessään se tervehtii ja antaa katsauksen, josta voidaan
jatkaa keskustelua. Selitysten taso sovitetaan käyttäjän osaamiseen.

Projektin painopiste on oppia paikallisen kielimallin käyttöä osana toimivaa
paikallista ohjelmaa. Tähtitaivas antaa tälle käytännön käyttökohteen:
malli muodostaa katsauksen, keskustelee tarkistetuista tiedoista ja auttaa
käyttämään ohjelman toimintoja. Kokemuksia hyödynnetään myöhemmin EKYssä
ja suunnitellussa opinnäytetyössä.

Oppimistuloksen osoittamiseen tarvitaan oikealla paikallisella mallilla
tehty katsaus, jatkokysymys ja ohjelman toimintaan liittyvä pyyntö.
Testimalli auttaa rakentamisessa, mutta ei yksin osoita tätä oppimistulosta.

## Aikataulu ja työmäärän rajaus

Tähtiapuri on rajattu oppimisprojekti, joka etenee käytettävissä olevan
ajan mukaan. Ensimmäinen tekninen pilotti pidetään pienenä. Kokeista
säilytetään valintaperusteet, tulokset ja avoimet rajoitukset tutkimusta
ja muihin projekteihin siirrettäviä oppeja varten.

Ensimmäisen käyttöversion rajaus säilyy; uudet laajennukset arvioidaan
oppimistavoitetta ja työmäärää vasten. Omaa valmistumispäivää ei ole sovittu.
Henkilökohtaiset ja muiden projektien aikataulut eivät kuulu julkiseen
projektisuunnitelmaan.

## Kohta 1: tarkoitus ja tavoite

Q1 on vastattu: käyttäjän kuvaama hyöty on keskusteleva, havaintopaikan
huomioiva illan tilannekatsaus. Kirjaus perustuu käyttäjän vastaukseen;
ensimmäisen version kaikkia ominaisuuksia ei vielä ole rajattu.

Tavoite: paikallinen tähtiavustaja antaa käynnistyessään käyttäjän
havaintopaikkaan ja iltaan sidotun katsauksen ja vastaa sen pohjalta
jatkokysymyksiin.

Käyttäjän havaittavissa oleva onnistumisen merkki: ohjelman avaamisen
jälkeen hän saa oman havaintopaikkansa illan yleiskuvan ja voi keskustella
kiinnostavasta kohteesta tai olosuhteesta samassa kontekstissa.
Numeeriset hyväksymisrajat ja testit tarkennetaan myöhemmissä kohdissa.

## Käyttäjän toivoma sisältö

| Aihe | Toivottu sisältö |
| --- | --- |
| Käynnistys | Tervehdys ja illan yleiskuva havaintopaikan ja ajan perusteella. |
| Planeetat | Mitkä ovat illan keskeiset planeetat, missä ja milloin niitä voi tarkkailla. |
| Kohdetiedot | RA/Dec, korkeus, atsimuutti ja ilmansuunta sekä näennäinen magnitudi. |
| Kuu | Kuun vaihe, sijainti ja illan kannalta olennainen tilanne. |
| Erikoistapahtumat | Paikalle ja ajalle relevantit ilmiöt, joiden tieto voidaan varmistaa. |
| Sää | Pilvisyystilanne tai -ennuste ja siihen liittyvä keskustelu. |
| Jatkokysymykset | Keskustelu samasta illasta ja kohteista ilman kontekstin antamista uudelleen. |

Tämä taulukko omistaa tavoitekuvan, ei vielä lopullista ensimmäisen version
ominaisuusluetteloa. Magnitudi tai horisontin yläpuolinen sijainti ei yksin
takaa käytännön näkyvyyttä. Ennusteen puuttuminen ja eri ilmiöiden
tietokattavuus tehdään näkyviksi.

Taivastiedot ja tähtikatalogi ovat ohjelman tietolähteitä, joita malli käyttää.
Kartta ja keskustelu perustuvat samaan paikan ja ajan mukaiseen laskentaan;
mallin muistia ei käytetä koordinaattien tai ajankohtaisen pilvisyyden lähteenä.
Tarkat laskenta- ja turvallisuusvastuut omistaa
[perusarkkitehtuuri](../architecture/base-architecture.md).

## Kohta 2: sovittu ensimmäisen version rajaus

Q2 on vastattu: käyttäjä hyväksyi ehdotetun rajauksen ja kevyen tähtikartan
mukaanoton. D3-Celestial on ensisijainen arvioitava karttaehdokas.
Tarkka versio, riippuvuudet ja aineistot arvioidaan ennen käyttöönottoa.

Ensimmäinen kokonaisuus kattaa:

- Yhden aktiivisen havaintopaikan ja yhden illan kontekstin; asetuksiin
  tallennetaan muutamia valittavia, nimettyjä paikkoja omilla koordinaateilla.
- Käynnistyksen katsauksen ja siitä jatkuvan keskustelun.
- Kohdassa 5 sovitun paikallisesti tallentuvan ja poistettavan keskusteluhistorian,
  jota malli voi hyödyntää ohjelman rajaamana kontekstina.
- Kuun ja planeettojen tarkistetut kohdetiedot sekä pilvisyysennusteen.
- Kevyen paikallisen taivaskartan: tähdet, tärkeät tähdistöviivat,
  horisontti ja ilmansuunnat, Kuu ja planeetat.
- Kohteen valinnan kartalta ja saman kohteen tiedot keskustelun tueksi.

Laaja planetaario, yksityiskohtainen maisema, taivaskuvien suoratoisto,
kaukoputkiohjaus sekä kattavat satelliitti- ja komeettaluettelot jätetään
myöhempään vaiheeseen. Erikoistapahtumien ensimmäinen tuettu joukko
valitaan omana rajattuna lisäyksenään.

Käyttäjätietojen vienti ja palautus rajattiin kohdassa 5 myöhemmäksi.
Niitä ei lisätä ensimmäiseen versioon.

Kartta, tähtiaineisto, laskenta ja kielimalli tavoitellaan paikallisesti
toimiviksi ilman ajonaikaista internetyhteyttä. Ajantasaisen pilvisyysennusteen
päivitys on erillinen ulkoinen sää-API-toiminto; koko kokonaisuutta ei siksi
kuvata kaikissa käyttötiloissa täysin verkkoyhteydettömäksi.

Toteutusvaihtoehdot ja eristysvastuut ovat
[perusarkkitehtuurissa](../architecture/base-architecture.md#taivaskartan-toteutusehdotus).
Tämä rajaus ei ole sovelluskoodin aloituspyyntö.

## Tallennetut havaintopaikat

Käyttäjän täsmennys: ohjelmaa käytetään muutamassa eri havaintopaikassa.
Asetuksissa voi määrittää paikan nimen ja koordinaatit sekä tallentaa muutamia
valittavia havaintopaikkaprofiileja. Ne säilyvät sovelluksen uudelleenkäynnistyksessä.
Aktiivinen paikka näkyy käyttäjälle; laskenta, kartta, keskustelu ja sää
sidotaan siihen. Profiili tarkoittaa havaintopaikkaa, ei uutta käyttäjätiliä.

Sääpalveluksi on valittu Ilmatieteen laitoksen avoin data. Sääpäivityksen
automaattinen tai manuaalinen tapa on samassa asetusvalikossa.
Kohdassa 5 sovittiin viimeksi käytetyn paikan muistaminen käynnistyksessä.
Havaintopaikkojen tallennusmuoto, poistaminen ja mahdollinen paikanvaihdon
säähaku täsmennetään tiedon elinkaaressa ja käyttöliittymän suunnittelussa.
Paikat ovat yksityistä käyttäjädataa.

## Kohta 3: käyttötapaukset ja poikkeukset

Sovittu sääpäivitys tarjoaa käyttäjälle kaksi valittavaa tapaa:
automaattinen päivitys heti käynnistyksessä tai päivitys käyttäjän pyynnöstä.
Molemmat käyttävät samaa valvottua säätoimintoa. Kohdassa 5 sovittiin,
että hakutavan valinta säilyy ja ensimmäisen käynnistyksen oletus on manuaalinen.

Käyttäjä painotti tietoturvallista backendin kautta kulkevaa sääpyyntöä
ja muun ulosmenevän liikenteen estämistä. Tekninen eristysmekanismi
arvioidaan arkkitehtuuri- ja turvallisuuskohdissa.

Käyttäjä valitsi yhden yhteisen käynnistyskatsauksen. Automaattitilassa
säähaun tulos otetaan mukaan ennen ensimmäisen katsauksen muodostamista.
Käyttäjä täsmensi käynnistyksen: kartta avautuu nykyhetkeen ja paikallinen
malli antaa illan katsauksen. Tarkentavalla pyynnöllä voidaan näyttää kohde
kartalta nykyhetkessä tai tulevassa ajankohdassa. Asetuksista valitaan
säähaun automaattinen tai pyydettäessä toimiva tapa.

Kohdan 3 pääkäyttötapaukset on hyväksytty. Tarkat poikkeusrajat, kuten
säähaun aikaraja, käsitellään teknisessä suunnittelussa ja testauskohdassa.
Käyttäjälle näkyvien polkujen ja erillisten lisäehdotusten omistaja on
[käyttötapauskuvaus](observing-session-use-cases.md).
