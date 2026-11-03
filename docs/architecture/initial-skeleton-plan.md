# Ensimmäinen runko ja kevyt paikallinen backend

Tämä on toteutusvaiheen ehdotus. Päätösten tilan kokoaa
[päätöshakemisto](../planning/decisions.md). Käyttäjä on valtuuttanut toteutuksen
aloittamisen issue kerrallaan; ensimmäisen kokeen lähtötiedot ovat
[kokeen kuvauksessa](../experiments/model-pilot.md). Ajettavaa runkoa ei vielä ole.
Sovellusjaon omistaa [perusarkkitehtuuri](base-architecture.md);
oikeusrajat ja eristyksen käyttöönoton ehdot
[turvallisuussuunnitelma](security-and-permissions-plan.md).

## Miksi backend jo ensimmäiseen runkoon

Suositus on pieni paikallinen Node/TypeScript-backend Electronin hallitsemana.
Sama rajapinta palvelee käyttöliittymää ja rajattuja agenttityökaluja.
Backend omistaa syötteen tarkistuksen, käyttötapaukset, työkalupolitiikan,
mallitehtävien koordinoinnin ja myöhemmin tallennuksen.

Tuleva sää-API kulkee backendin sääportin kautta eristetylle säätyöntekijälle.
Käyttöliittymä ja kielimalli eivät tee ulkoisia kutsuja itse.
Aluksi portti voi palauttaa synteettisen ennusteen tai tiedon sen puuttumisesta.

Electron-mainiin jäävät ikkunat, valvottu välitys ja prosessien elinkaari.
Node/TypeScript-runtime toimitetaan desktopin mukana; erillinen käyttäjän
Node-, Python- tai palvelinasennus ei ole tavoite. Electronin hallittu
utilityProcess on backendin ajotapaehdokas, ei turvallisuushiekkalaatikko.

Sisääntulon kuljetussovitin on ohut IPC-adapteri. Käyttäjän valinnan ja
[vertailun](base-architecture.md#paikallinen-http-vai-suora-prosessikanava)
omistaa perusarkkitehtuuri. Tähän backend-yhteyteen ei lisätä HTTP-palvelinta
tai HTTP-frameworkia. Viestisopimuksen ja kanavan oikeusrajat todennetaan.

## Ehdotettu etenemisjärjestys

Koko projektin vaiheet, riippuvuudet ja työpaketit omistaa nyt
[roadmap](../planning/roadmap.md). Ensimmäinen tekninen tavoite on P1:
pieni desktop/IPC-runko ja oikea 4B/8B-mallikoe synteettisellä aineistolla.
Varsinainen tähtilaskenta, kartta, sää ja tietojen säilytys yhdistetään
roadmapin myöhemmissä työpaketeissa.

Tämä dokumentti omistaa rungon tekniset vastuut. Se ei ylläpidä toista
työjonoa tai samaa vaiheistusta erillisenä taulukkona.

## Rungon rakentamisen periaatteet

- Lähdekoodin kieli on TypeScript; mallin natiivimoottori voi käyttää
  muuta tekniikkaa sovittimen takana. Python-palvelinta ei tarvita oletuksena.
- Vain tarpeelliset sovellukset ja paketit luodaan. Yksi käyttötapaus
  kulkee valittujen kerrosten läpi ennen uusien ominaisuuksien aloittamista.
- Pakettien rakennus seuraa riippuvuuksia: puhdas domain ja rajapinnat ennen
  niiden kuluttajia. Ulkoisia kirjastoja ei niputeta domainin vastuuksi.
- Monorepon paketinhallinta, testityökalut, versiot ja komennot sovitaan
  ennen käyttöönottoa. EKYn komentoja tai asetuksia ei kopioida sokkona.
- Kehitys-, testi- ja käyttäjädata pidetään erillään. Testit käyttävät omaa
  tilapäistä datajuurta; testikomentoja ei lisätä tuotannon rajapintaan.
- Rakennus ei lataa mallia tai lähetä sijaintia sivuvaikutuksena.
  Paketoinnin resurssit määritellään sallittujen tiedostojen listana.

Tarkistukset perustuvat [testausohjeeseen](../ai/testing-rules.md).
Toteutusvaiheessa määritellään todelliset typecheck-, build- ja testikomennot.
Dokumenttiin kirjoitettu esimerkkipolku tai tuleva tarkistus ei ole ajettu koe.

## Ennen verkkokokeilua ratkaistavat asiat

Sääpalveluksi on valittu Ilmatieteen laitoksen avoin data. Varmennetaan
rajattu ennustekysely sekä valitaan kohdealustan verkko- ja tiedostorajaus.
Säätyöntekijä tarvitsee rajatun HTTPS-yhteyden. Backendin ja mallimoottorin
ulospääsy estetään erikseen; niiden paikallinen viestintä sallitaan vain tarpeen mukaan.

Rajoituksen pitää toimia myös paketoidussa sovelluksessa ja mallimoottorin
käyttämällä CPU/GPU-polulla. Jos eristystä ei vielä pystytä todentamaan,
kokeilu jatkuu offline-aineistolla. Virtuaalikone voidaan myöhemmin arvioida
eristyskokeeksi, mutta se ei ole loppukäyttäjän asennuksen oletusvaatimus.
