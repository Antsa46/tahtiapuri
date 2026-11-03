# Julkisten projektitekstien yksityisyys

Tämä ohje koskee versionoituja tiedostoja, issueita, kommentteja,
PR-kuvauksia, committiviestejä ja muita julkisia projektitekstejä.

Julkinen aineisto kuvaa tämän projektin tavoitteen, tekniikan,
arkkitehtuurin, riippuvuudet ja todentamisen. Se ei kuvaa kehittäjän
henkilökohtaista ympäristöä tai muiden projektien taustaa.

## Paikallinen kehityskonteksti

Yksilöivät kehitysmuistiinpanot säilytetään projektin juuressa olevassa
`.tahtiapuri-local/`-hakemistossa. Koko hakemisto on Gitistä ohitettu.

- `README.md` on lyhyt paikallinen lukureitti.
- `local-context.md` sisältää vain työn kannalta tarpeellisen yksityisen taustan.
- `local-toolchain-runbook.md` kuvaa paikalliset työkalut ja ajamisen havainnot.
- `toolchain.local.json` sisältää koneellisesti luettavan inventaarion,
  sen lähteen ja tarkistusajankohdan.

Näitä tiedostoja ei versionoida. Julkisessa ohjeessa säilyvät vain tämä
käytäntö ja suhteelliset tiedostonimet. Jos muistiinpanoja ei ole,
tarkistamattomia konekohtaisia tietoja ei päätellä tai keksitä.

Lue muistiinpanot vain tehtävän vaatimassa laajuudessa. Merkitse tietoihin
lähde ja ajantasaisuus; vanha havainto ei ole uusi tarkistus. Älä tallenna
salaisuuksia tai kopioi toisen projektin yksityisiä tietoja.
Varmista ennen tallennusta `git check-ignore -v --no-index`-komennolla,
että kyseinen polku on ohitettu, ja tarkista ettei se ole jo versionoitu.
Älä käytä hakemistoon `git add -f` -komentoa.

Kehityskonteksti erotetaan sovelluksen käyttäjätiedoista ja mallin syötteistä.
Hakemisto ei kuulu asennus-, tuki- tai vientipaketteihin eikä julkaistaviin
testiartifakteihin. Nykyiset työkalut, mallipainot ja ajonaikainen data
säilyvät `.local/`-puussa; generoidut testitulokset säilyvät `.artifacts/`-puussa.

## Julkisen ja paikallisen tiedon raja

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

Tokeniseuranta säilyy julkisissa GitHub-issueissa tehtäväkohtaisina
koontilukuina myös työn valmistuttua. Tokenimäärät eivät ole yksilöiviä
konetietoja, eikä niitä poisteta yksityisyyssiivouksessa. Säilytä käytetty
GPT-malli, mitatut input-, cached input-, output- ja kokonaismäärät sekä
lähteen, rajauksen ja puuttuvien tietojen kuvaus
[kehitysmalliohjeen](../ai/development-models.md#mallin-ilmoittaminen-ja-issuekohtainen-tokeniseuranta)
mukaan. Tarkat istuntoaikaleimat, tunnisteet ja tilitiedot pysyvät paikallisina.

Numeerinen testimäärä ei ole sama asia kuin konekohtainen suorituskykymittaus.

Säilytä tarpeelliset ulkopuoliset lähteet sekä lisenssi- ja tekijätiedot.
Käytä oman repositoryn tehtävistä numeroviitteitä ja tiedostoista suhteellisia
linkkejä, jotta ohjeisiin ei tarvitse kovakoodata henkilökohtaista omistajatunnusta.

Ennen julkaisua tarkista koko julkaistava diff ja julkinen kuvausteksti.
Pelkkä .gitignore ei suojaa käsin raporttiin kopioituja arvoja.
Raakadataa tai kuvakaappausta ei julkaista sellaisenaan.

Vanhaa Git-historiaa ei kirjoiteta uudelleen tämän ohjeen perusteella.
Nykyisten tekstien siistiminen ei poista palvelun omia omistaja-, tekijä-
tai muokkaushistoriatietoja.
