# Julkisten projektitekstien yksityisyys

Tämä ohje koskee versionoituja tiedostoja, issueita, kommentteja,
PR-kuvauksia, committiviestejä ja muita julkisia projektitekstejä.

Julkinen aineisto kuvaa tämän projektin tavoitteen, tekniikan,
arkkitehtuurin, riippuvuudet ja todentamisen. Se ei kuvaa kehittäjän
henkilökohtaista ympäristöä tai muiden projektien taustaa.

Pidä vain paikallisissa, Gitistä rajatuissa artefakteissa:

- todellinen CPU/GPU-malli, asennettu muisti, ajuri- ja käyttöjärjestelmäkooste
- laite- ja käyttäjätunnisteet, koneen nimi, käyttäjätilit ja kotihakemistot
- absoluuttiset kehitysympäristön polut sekä konekohtaiset viive-, muisti-
  ja suorituskykymittaukset
- ajon satunnaistunnisteet, prosessitunnisteet ja tarkat istuntoaikaleimat
- oikeat sijainnit, keskustelut, henkilökohtaiset välineet ja muu käyttäjäaineisto
- muiden yksityisten projektien nimet, rakenne, aikataulut ja yritysyhteydet.

Käytä julkisissa esimerkeissä synteettistä aineistoa, projektisuhteisia
polkuja ja yleisiä roolikuvauksia. Mallien koot, julkaisurevisiot,
riippuvuuksien täsmäversiot, geneerinen kohdealusta, koemenetelmä ja
laadulliset löydökset saa dokumentoida. Ne eivät ole koneinventaario.

Tokeniseuranta säilyy tehtäväkohtaisina koontilukuina ilman yksityisiä
istunto- tai tilitietoja. Numeerinen testimäärä ei ole sama asia kuin
konekohtainen suorituskykymittaus.

Säilytä tarpeelliset ulkopuoliset lähteet sekä lisenssi- ja tekijätiedot.
Käytä oman repositoryn tehtävistä numeroviitteitä ja tiedostoista suhteellisia
linkkejä, jotta ohjeisiin ei tarvitse kovakoodata henkilökohtaista omistajatunnusta.

Ennen julkaisua tarkista koko julkaistava diff ja julkinen kuvausteksti.
Pelkkä .gitignore ei suojaa käsin raporttiin kopioituja arvoja.
Raakadataa tai kuvakaappausta ei julkaista sellaisenaan.

Vanhaa Git-historiaa ei kirjoiteta uudelleen tämän ohjeen perusteella.
Nykyisten tekstien siistiminen ei poista palvelun omia omistaja-, tekijä-
tai muokkaushistoriatietoja.
