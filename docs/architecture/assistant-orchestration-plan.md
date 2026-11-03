# Avustajan sijoittelu ja agenttien orkestrointi

Tila: työnkulun perusmalli hyväksytty suunnittelun pohjaksi 2.11.2026.
Kansiorakenne A, backendin assistant-koordinaattorin ohjelmakoodissa ohjaama
työnkulku, rajatut malliroolit ja omistavien moduulien tarkistamat työkalut
on sovittu lähtökohdaksi. Tarkat sopimukset, rajat ja moduulin sisäinen
kansiojako ovat vielä ehdotuksia. Ajonaikaista toteutusta ei ole.
Valintojen tilan kokoaa [päätöshakemisto](../planning/decisions.md).

[Perusarkkitehtuuri](base-architecture.md) omistaa moduulit ja luottamusrajat.
[Mallisuunnitelma](local-model-plan.md) omistaa ajomoottorin, mallisovittimen,
vertailun ja Codexin kehitysrajapinnan. Tämä dokumentti omistaa AI:n
työnkulun ja roolien vastuut. Se ei muuta EKYn ohjeita tai toteutusta.

## Arkkitehtuurin lähtökohta

Tähtiapurin avustaja käyttää samoja omistavia backend-palveluita kuin
käyttöliittymä. Malli ei omista sovellusdataa tai päätä käyttöoikeuksia.
Koordinaattori kokoaa rajatun kontekstin, ja moduulit tarkistavat
työkalupyynnöt ennen suorittamista.

Ensimmäinen pilotti on modulaarinen paikallinen kokonaisuus. Yleistä
päämallin ja aliagenttien alustaa tai erillistä orkestrointipalvelua
ei rakenneta ilman todettua tarvetta.

## Sovittu työnjaon perusmalli

| Osa | Omistaa |
| --- | --- |
| assistant/application: koordinaattori | Tehtävän tila, tarvittavan aineiston kokoaminen, roolivalinta, työjono, aikarajat, peruutus ja toimintoehdotusten käsittely. |
| Agenttirooli | Rajattu tehtävä, rooliohje, sallittu konteksti ja vastaussopimus. Mahdollinen seuraavan vaiheen ehdotus tarkistetaan ohjelmakoodissa. |
| Mallisovitin ja moottori | Rajatun mallipyynnön muunnos protokollaan sekä tekstin tai rakenteisen tuloksen laskenta. |
| Työkalun omistava moduuli | Oma käyttötapaus, säännöt, data ja toiminnon hyväksyntä. |
| Electron main | Prosessien elinkaari ja valvottu käyttöliittymän välitys. |

Koordinaattori on TypeScript-ohjelmakoodia. Malli voi ehdottaa kohdetta,
työkalukutsua tai seuraavaa roolia. Se ei päätä omista oikeuksistaan,
muuta muiden moduulien sääntöjä tai omista koko sovelluksen toimintaa.
Sovittu [pysyvien muutosten käyttöliittymäraja](security-and-permissions-plan.md#avustajan-käynnistämät-pysyvät-muutokset)
rajaa myös avustajan työkaluluettelon.
IPC-sisääntuloadapteri välittää tarkistetun pyynnön käyttötapaukselle:
keskustelun työnkulku ei kuulu viestin vastaanottimeen tai Electron mainiin.

Kartta-, asetus- ja muut tavalliset käyttöliittymäpyynnöt kulkevat suoraan
omistavien backend-moduulien käyttötapauksiin. Avustajamoduulia ei tehdä
kaiken sovellustoiminnan pakolliseksi välikerrokseksi. Mallin puuttuessa
deterministiset toiminnot voivat jatkaa toimintaansa. Alla oleva kuva
esittää keskustelun polun.

~~~mermaid
flowchart TD
  UI["Käyttöliittymä Electron-välityksen kautta"] --> O["Backendin assistant-koordinaattori"]
  O --> R["Rajattu opastaja- tai suunnittelijarooli"]
  R --> M["Mallisovitin ja paikallinen moottori"]
  M -->|"Vastaus tai toimintoehdotus"| O
  O --> T["Työkalupyynnön tarkistus"]
  T --> D["sky / planning / observing / weather"]
  D -->|"Tarkistetut tiedot tai tulos"| O
  O -->|"Vastaus ja hyväksytty näkymätoiminto"| UI
~~~

## Sijoitus A-rakenteessa

~~~text
apps/backend/src/modules/assistant/
  application/
    orchestration/          # Työnkulku, jono, rajat ja peruutus
    roles/                  # Opastajan ja myöhemmän suunnittelijan tehtävät
    tools/                  # Nimettyjen työkalujen sovitus julkisiin portteihin
  ports/                    # Mallin ja tarvittavien tietopalvelujen sopimukset
  adapters/                 # Esimerkiksi llama.cpp-yhteyden sovitus
~~~

Tämä on vastuujaon kuva. Alikansioita ei luoda ennen niiden tarvetta.
composition/ kytkee konkreettiset toteutukset käyttötapausten portteihin.

assistantin tools/ ei kopioi muiden moduulien sääntöjä tai kutsu niiden
sisäisiä toteutuksia. Sallitut kytkennät ovat julkisia sopimuksia.
planning-moduulin laskennalliset havaintoehdot ja mahdollinen
suunnittelija-agentti ovat eri vastuita: agentti ehdottaa, moduuli tarkistaa.
Domainissa ei ole mallimoottorin tai agenttikehyksen riippuvuutta.

## Yksi pääavustaja ja mahdollinen delegointi

Käyttäjälle voi näkyä yksi pääavustaja. Alkuun yksi opastajarooli ja
ohjelmakoodin ohjaama työnkulku riittävät. Suunnittelijarooli lisätään
verrattavaksi kokeeksi, kun lähtötaso toimii. Roolit voivat käyttää samaa
ladattua Poro- tai Ministral-mallia vuorotellen.

Myöhemmässä kokeessa pääavustajan mallivastaus voi ehdottaa delegointia.
Ohjelma hyväksyy vain tunnetun roolin, rajatun tehtävän ja sallitun aineiston.
Lapsirooli saa enintään sille ohjelmassa määritellyt ja kyseiseen tehtävään
myönnetyt oikeudet. Se ei saa uusia työkaluja emomallin ohjeesta.
Roolikutsujen määrä, syvyys, tokenit ja kokonaisaika ovat rajattuja.
Mallin tuloste ei luo mielivaltaisia uusia agentteja tai uusia oikeuksia.

Jokainen tehtävä sidotaan alkuperäiseen paikkaan, aikaan ja pyyntöön.
Paikanvaihto tai peruutus estää vanhan työn tulosta muuttamasta uutta
näkymää. Mallin ehdottama säätyökalu noudattaa samoja sovittuja
käynnistystapoja kuin muu sovellus; roolin nimi ei anna verkkolupaa.
Säätyöntekijä ja tähtilaskenta voivat olla kokonaan determinististä koodia.

## Ensimmäinen harjoiteltava työnkulku

Käynnistyskatsauksessa ohjelma tuntee jo tarvittavan tehtävän. Se laskee
taivastiedot ja hankkii sään käyttäjän asetuksen mukaisesti. Malli saa rajatun
aineiston ja muodostaa katsauksen. Mallia ei tarvita päättämään, pitäisikö
ohjelman käynnistyessä hakea säätä. Nykyhetken kartta ei odota katsausta.

Jatkokysymyksessä malli voi pyytää lisätietoa tai ehdottaa kartan kohdetta
ja aikaa. Ohjelma validoi pyynnön, käyttää moduulin palvelua ja palauttaa
tuloksen mallille. Numeerinen kortti perustuu laskentaan; vapaamuotoisen
selityksen oikeellisuutta arvioidaan erikseen.

Assistant-moduuli kokoaa keskustelukontekstin omistamansa historiaportin
kautta. Käyttäjän sallima historian käyttö on rajattua; poistettu aineisto
ei saa palata kontekstiin. Tallennus- ja hakusopimuksen omistaa
[tiedon elinkaari](data-lifecycle-plan.md).

Codexin erikseen aktivoitu kehitysyhteys käyttää samaa mallisovitinta.
Suora mallikoe ei suorita mallin työkalupyyntöjä automaattisesti.
Käyttötapauskoe kulkee saman koordinaattorin ja politiikan kautta kuin UI.
Kehitysrajapinnan tekninen sopimus pysyy mallisuunnitelmassa.

## EKYlle siirtyvä oppi ja avoin jatko

Siirrettävä tulos on kokeiltu työnkulun, mallisovittimen ja nimettyjen
työkalujen sopimus sekä peruutuksen, resurssirajojen ja virhetilojen näyttö.
Tähtiapurin taivaslogiikkaa tai yhtä yhteistä pääohjainta ei siirretä EKYyn.

Siirrettävän ratkaisun kohdeprojekti määrittelee omat toimija- ja
oikeusrajansa. Tähtiapurin käyttötapaus ei päätä toisen sovelluksen
kirjoitusoikeuksia, identiteettejä tai hyväksyntäpolitiikkaa.

Avoinna ovat ensimmäisten roolien tarkat tehtävät, työkalujen nimet ja
tietomuodot ja resurssirajat. Kehitysyhteyden suunta on stdio-MCP;
backendin IPC, todentaminen ja aktivointi täsmennetään mallisuunnitelmassa.
Yhden ja kahden roolin hyöty arvioidaan mallikokeessa; yleistä agenttialustaa ei toteuteta
ennakkoon. Tekniseen jäljitykseen kerätään vain sovitut vähimmäistiedot,
ei koko yksityistä keskustelua tai havaintopaikan koordinaatteja.
