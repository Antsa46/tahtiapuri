# Havaintoillan käyttötapaukset

Tämä dokumentti omistaa aloituskierroksen kohdan 3 käyttäjäpolut ja
poikkeukset. Tuotteen tavoite ja sovittu rajaus ovat
[projektin määrittelyssä](project-definition.md), tekniset luottamusrajat
[perusarkkitehtuurissa](../architecture/base-architecture.md) ja
suunnittelun valinnat [päätöshakemistossa](../planning/decisions.md).

Käyttäjä hyväksyi pääkäyttötapaukset ja täsmensi nykyhetken kartan,
paikallisen mallin yhteisen aloituskatsauksen, kartan ohjaamisen keskustelusta
sekä sääasetukset. Tarkat tekniset virherajat ja lopun lisäkokeet ovat vielä
ehdotuksia; niitä ei tulkita valmiiksi toteutetuiksi ominaisuuksiksi.

## UC-01: käynnistys ja illan katsaus

Tavoite: käyttäjä saa havaintopaikkansa illan tilanteen ja voi jatkaa keskustelua.

Syötteet: valittu havaintopaikka, aikavyöhyke, nykyhetki ja illan aikaväli
sekä sääpäivityksen asetus.

Tavallinen kulku:

1. Sovellus lataa paikalliset kartta- ja malliresurssit sekä käytössä olevan
   havaintokontekstin.
2. Backend laskee nykyhetken taivaskartan tiedot ja kartta tulee näkyviin
   paikallisten tietojen valmistuttua. Mallin käynnistys, illan laskenta ja
   automaattitilan säähaku voivat valmistua rinnakkain.
3. Automaattitilassa backend odottaa säähaun tulosta rajatun ajan.
   Pyyntötilassa käynnistys ei tee ulkoista säähakua.
4. Backend kokoaa tarkistetuista taivas- ja säätiedoista yhden katsauksen
   aineiston. Jos sää puuttuu, tämä tila sisältyy aineistoon.
5. Paikallinen malli muodostaa yhden yhteisen tervehdyksen ja illan katsauksen.
   Nykyhetken kartan ja illan katsauksen ajankohdat näkyvät erikseen.
   Kartan avaaminen ei odota mallin vastausta tai sääpalvelua.
6. Käyttäjä jatkaa keskustelua tai valitsee kohteen kartalta.

Hyväksymisehto: käyttäjä saa yhden yhteisen käynnistyskatsauksen, jossa
näkyvät paikka, ajankohta ja sääennusteen saatavuus sekä ajantasaisuus.
Valmistelun aikana voidaan näyttää lataustila; erillistä taivaskatsausta
ja sen jälkeistä automaattista sääkatsausta ei tuoteta.

Sovittu valinta: automaattitilassa toimivan säähaun tulos otetaan mukaan
ensimmäiseen yhteiseen katsaukseen. Pyyntötilassa katsaus kertoo sään
puuttumisesta, ellei käyttökelpoista ennustetta ole jo saatavilla.

Virhetilanteen suositus: säähaun aikakatkaisu tai virhe ei estä katsausta
rajattomasti. Yhteinen katsaus annetaan saatavilla olevilla tiedoilla ja
puuttuva sää kerrotaan selvästi. Tarkka aikaraja sovitaan myöhemmin.

Jos havaintopaikka puuttuu, sovellus pyytää valitsemaan sen ennen
paikkasidonnaista katsausta. Tallennetun paikan ja käynnistyksen
paikkavalinnan kuvaa UC-06. Tallennussopimuksen omistaa tiedon elinkaari.

## UC-02: jatkokysymys ja kartan ohjaaminen

Tavoite: käyttäjä voi kysyä kohteesta tai havaintoajasta antamatta
paikkaa ja iltaa uudelleen.

Sovellus käyttää aktiivista kontekstia ja kysymyksen tarvitsemia tarkistettuja
kohdetietoja. Jos kysymys vaihtaa paikkaa tai aikaa, uusi konteksti käsitellään
näkyvästi. Malli ei täydennä puuttuvaa laskentatietoa keksityllä luvulla.

Hyväksymisehto: vastauksen kohde ja ajankohta vastaavat kysymystä ja
voimassa olevaa havaintokontekstia.

Sovittu toiminta: tarkentava kohde- ja aikapyyntö voi näyttää tilanteen
suoraan kartalta nyt tai tulevaisuudessa. Esimerkiksi näytä Jupiter huomenna
klo 22 kohdistaa kartan kyseiseen kohteeseen ja ajankohtaan. Ohjelma käyttää
laskettuja tietoja ja näyttää aktiivisen ajan selvästi.

Jos vastaus vertailee useita ajankohtia, ne erotetaan tekstissä ja kartan
valittu hetki merkitään näkyvästi. Vertailun tarkka esitystapa täsmennetään
teknisessä suunnittelussa. Ajan vaihtaminen ei itsessään laajenna
sääpäivityksen sovittuja käynnistystapoja.

## UC-03: kohteen valinta kartalta

Tavoite: käyttäjä tutkii kartalla näkyvää kohdetta ja keskustelee siitä.

Karttanäkymä välittää kohdetunnisteen rajattua sovellusrajapintaa pitkin.
Backend tarkistaa tunnisteen ja kontekstin. Kohdekortti ja keskustelun
aineisto saavat saman kohteen tarkistetut tiedot.

Hyväksymisehto: valittu kohde, sen kortti ja keskustelu viittaavat samaan
kohteeseen ja ajankohtaan. Kartan valinta ei anna tiedosto- tai verkko-oikeutta.

## UC-04: sääpäivitys

Tavoite: käyttäjä saa pilvisyysennusteen valitulle havaintopaikalle ja illalle.

Automaattinen päivitys käynnistyy sovelluksen käynnistyksessä vain, jos
käyttäjä on valinnut automaattitilan. Pyyntötilassa päivitys käynnistyy
käyttäjän sääpäivityspyynnöstä. Pelkkä mallin tuottama teksti ei muuta asetusta.

Molemmat käynnistäjät kutsuvat samaa backendin sääkäyttötapausta.
Sääroolilla on vain nimetty ennustetyökalu; ulkoisen HTTPS-pyynnön tekee
rajattu säätyöntekijä. Teknistä kutsusopimusta ei päätetä tässä dokumentissa.

Kustakin havaintopaikasta säilyy viimeisin onnistunut ennuste myös seuraavaan
käynnistykseen. Käyttäjä näkee ennusteen iän ja kattaman ajanjakson;
vanhaa ennustetta ei esitetä tuoreena. Välimuistin puute tai vanheneminen
ei itsessään käynnistä säähakua. Tallennussopimuksen omistaa
[tiedon elinkaari](../architecture/data-lifecycle-plan.md).

Hyväksymisehto: käyttäjä näkee ennusteen lähteen, ennusteajankohdan ja
noutoajan. Pyyntötilan tavallinen käynnistys ei tee sää-API-kutsua.
Asetuksen oletusarvo ja säilyminen on sovittu UC-05:ssä.

## UC-05: sääasetuksen valinta

Tavoite: käyttäjä valitsee asetuksista automaattisen säähaun käynnistyksessä
tai sääpäivityksen vain pyydettäessä.

Valittu tapa näytetään asetuksissa ja ohjelma noudattaa sitä.
Mallin vastaus ei muuta asetusta itsenäisesti. Kohdassa 5 sovittiin,
että valinta säilyy käynnistysten yli ja ensimmäisen käynnistyksen
asetus on manuaalinen. Tallennussopimuksen omistaa
[tiedon elinkaari](../architecture/data-lifecycle-plan.md).

Hyväksymisehto: käyttäjän valinta vastaa todellista hakukäyttäytymistä.

## UC-06: havaintopaikkojen tallennus ja valinta

Tavoite: käyttäjä määrittää asetuksissa muutaman nimetyn havaintopaikan ja
koordinaatit sekä valitsee käyttöön niistä yhden. Paikat säilyvät sulkemisen
ja uudelleenkäynnistyksen yli. Paikkaprofiilit kuuluvat saman käyttäjän
asetuksiin, eivät erilliseen käyttäjähallintaan.

Hyväksymisehto: tallennetut nimet ja koordinaatit löytyvät seuraavalla
käynnistyksellä. Aktiivinen paikka näkyy, ja kartta sekä uudet kohde-,
keskustelu- ja sääpyynnöt käyttävät sitä. Toisen paikan ennustetta ei näytetä
valitun paikan ennusteena.

Tekninen jatko: koordinaatit validoidaan backendissä. Keskeneräisen mallityön
tai säähaun tulos ei saa paikanvaihdon jälkeen muuttaa uuden paikan näkymää.
Käyttäjän valinta kohdassa 5: käynnistys muistaa viimeksi käytetyn paikan,
ja sen nimi näkyy heti kartan yhteydessä. Jos kelvollista paikkaa ei ole,
käyttäjä valitsee sen ennen paikkasidonnaista katsausta.
Tallennusmuoto ja paikanvaihdon mahdollinen automaattinen säähaku ovat
avoimia; olemassa olevia säähakujen käynnistystapoja ei laajenneta.

## UC-07: keskusteluhistorian käyttö ja poistaminen

Käyttäjä valitsi kohdassa 5 paikallisesti tallentuvat keskustelut, jotka
säilyvät, kunnes hän itse poistaa ne. Yksittäisen keskustelun tai koko
historian voi poistaa. Paikallinen malli voi käyttää säilytettyä historiaa
keskustelun kontekstina.

Tavoite: käyttäjä voi palata aiempaan keskusteluun ja keskustella sen
pohjalta. Ohjelma antaa mallille tarpeellisen rajatun historian.
Historia ei vaihda aktiivista havaintopaikkaa tai aikaa huomaamatta.

Hyväksymisehto: keskustelu löytyy uudelleenkäynnistyksen jälkeen eikä
poistu automaattisesti ajan perusteella. Yhden keskustelun poisto säilyttää
muut keskustelut; koko historian poisto poistaa kaikki keskustelut.
Poistettu keskustelu ei ole enää historian haettavissa tai uuden
mallikontekstin käytettävissä. Historiallinen sää tai kohdetieto ei näy
nykyhetken tietona. Tarkat poistotoiminnot ja teknisen tallennussopimuksen
omistaa [tiedon elinkaari](../architecture/data-lifecycle-plan.md).

## UC-08: paikallisen mallin valinta

Käyttäjä valitsi kohdassa 7 mahdollisuuden vaihtaa paikallismallia
sovelluksen asetuksista. Tavoite: samoja keskustelu- ja havaintotehtäviä
voi käyttää eri paikallismalleilla. Vertailupainot säilyvät erillisessä
mallikansiossa, joten mallivalikoima ei kasvata sovelluksen asennuspakettia.

Ehdotettu asetustoiminto antaa käyttäjän valita paikallisen mallikansion
ja ottaa tarkistetun mallin käyttöön. Käyttäjä näkee hyväksytyt mallit
ja valitsee niistä yhden. Ohjelma näyttää vaihdon tilan sekä aktiivisen mallin.
Vaihto ei muuta tallennettuja keskusteluja, havaintopaikkaa tai
avustajan käyttöoikeuksia. Virheessä ohjelma kertoo, ettei valittu malli
ole käytettävissä; karttaa ja laskentaa voi silti käyttää.

Vaihdon ja kesken olevan vastauksen tarkka yhteensovitus on vielä ehdotus.
[Luettelo, lataus ja vaihtosopimus](../architecture/local-model-plan.md#mallien-valinta-asetuksista)
omistetaan mallisuunnitelmassa. Valinnan säilyminen käynnistysten yli on
[tiedon elinkaaressa](../architecture/data-lifecycle-plan.md) avoin päätös.

## Ehdotukset mallin käytön lisäkokeiksi

Nämä ovat Codexin ehdotuksia jatkosuunnitteluun, eivät uusia hyväksyttyjä
ensimmäisen version vaatimuksia:

- Käyttäjä pyytää perustelun: apuri nostaa esiin vastauksessa käytetyt
  kohdetiedot ja sääennusteen sekä kertoo puuttuvista tiedoista.
- Käyttäjä keskeyttää vastauksen tai korjaa pyyntöä: vanhentunut mallityö
  ei myöhemmin vaihda karttaa väärään kohteeseen tai ajankohtaan.
- Käyttäjä pyytää palaamaan nykyhetkeen: paikallisen mallin tulkitsema
  pyyntö palauttaa kartan ajan hallitusti nykyhetkeen.

Näillä voidaan harjoitella mallin ja ohjelman yhteistoimintaa.
Tarkka työkalurakenne suunnitellaan arkkitehtuurikohdassa.

## Puuttuvat tiedot, virheet ja keskeytys

Suositeltu käyttäytyminen jatkokäsittelyyn:

- Ilman verkkoa tai säähaun epäonnistuessa paikallinen kartta ja taivastiedot
  toimivat edelleen. Sään tila näkyy puuttuvana tai virheellisenä.
- Jos ennustevälimuisti päätetään toteuttaa, vanha ennuste näytetään vain
  selvästi merkittynä. Välimuistin säilytys ja tuoreusrajat sovitaan erikseen.
- Jos paikallinen malli ei käynnisty, laskentakortit ja kartta säilyvät
  käytettävinä ja keskustelun puuttuminen kerrotaan.
- Peruutus ja sulkeminen keskeyttävät omistetut työt hallitusti.
  Uusia sää- tai mallitehtäviä ei käynnistetä piilossa peruutuksen jälkeen.
- Sääpalvelun teksti tai mallivastaus ei avaa uusia työkaluja tai yhteyksiä.

Tarkat aikarajat, uusinnat, eristystestit ja valmistumisen näyttö
suunnitellaan [testausohjeen](../ai/testing-rules.md) mukaan.
