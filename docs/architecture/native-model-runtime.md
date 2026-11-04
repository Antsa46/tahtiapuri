# Natiivin mallisovittimen viesti- ja sulkusopimus

Tämä dokumentti omistaa Electronin tulevan natiivimallisovittimen rajatun
viestirajapinnan. [Ajotapasuunnitelma](model-execution-profiles.md) omistaa
valinnat ja [turvallisuussuunnitelma](security-and-permissions-plan.md)
oikeusrajat. T09j toteuttaa perustan; sovelluksen käynnistys käyttää edelleen
aiempaa SDK-/UtilityProcess-polkuansa. Natiivi parseri ei vielä käynnistä mallia.

## Toteutettu perusta

`packages/windows-runtime/native/` omistaa Windowsin yhteiset käynnistys-,
resurssi- ja kehystysosat. Testien vanhat headerit vain sisällyttävät nämä.
Synteettiset virhekomennot ja koetyöntekijät pysyvät tests/-puussa.
Sovelluskoodi ei sisällytä testejä. Käynnistin käyttää kutsujan määrittelemää
suljettua `LaunchSpec`-kuvausta; se ei ole rendererin tai mallin valittava API.

`OwnerInput` lukee omistajaputkea yhdessä säikeessä. Se tarkistaa istunnon,
järjestysnumeron, sallitut operaatiot sekä 32 kehyksen / 32 KiB:n kokonaisrajan.
Jonoon mahtuu enintään kahdeksan kehystä. Vahdin omistajatarkistus käyttää
tässä polussa atomista katoamislippua eikä lue samaa synkronista putkea.
Lukijasäikeen sululla on myös erillinen aikaraja vahdin elinkaaren jälkeen.
Havaitun omistajan katoamisen tai vahdin katkaisun tarkistus tehdään ennen
valmistelua, sen jälkeen sekä ennen prosessin luontia ja jatkamista.

`apps/desktop/src/main/native-model-protocol.ts` tarkistaa binäärisen
omistajakehyksen ja brokerin rivimuotoiset tulokset. Se ei vielä tarkista
koko käyttötapauksen viestijärjestystä, käynnistä prosesseja tai anna
sulkemisen hyväksyntää. Sovellusliitoksessa nämä vastuut kuuluvat
`run/cancel/stop`-portin toteuttavalle mainin omistajasovittimelle.

## Sisältö ja rajat

Main muodostaa TAIP-otsakkeen, oman 32 tavun istunnon ja kasvavat
pyyntönumerot. Yksi sovitininstanssi kuuluu yhteen prosessiin ja työhön.
Mallilta tai MCP:ltä ei oteta komentoa, tiedostopolkua tai eristysvalintaa.
Tavusovitin muodostaa vain hello-, load-, begin- ja shutdown-pyyntöjä.
Peruutus voidaan toteuttaa tämän yhden työn prosessin hallittuna sulkuna.

| Raja | Sopimus |
| --- | --- |
| Käyttäjäsyöte | Enintään 2 000 UTF-16-yksikköä ja 8 000 UTF-8-tavua, ei NULia tai virheellisiä surrogaatteja |
| Vastausteksti | Enintään 8 192 UTF-8-tavua, kelvollinen UTF-8, ei NULia |
| Konteksti | 4 096 tokenia; koko renderöity syöte enintään 3 072, tuotto enintään 512 |
| CPU-laskenta | Yksi säie, batch ja microbatch 32, ei GPU-kerroksia |
| Brokerin tuloste | Enintään 32 tietuetta, 16 896 tavua rivillä ja 65 536 tavua yhteensä |
| Virhevaihe | Suljettu vaiheavain, ei natiivin poikkeuksen tekstiä tai paikallista polkua |

Käynnistimen omat `launched` ja `result` ovat eri tietuetyypit kuin
mallityöntekijän `frame`. Työntekijän vastaus kulkee heksakoodatussa rungossa;
sen teksti ei muutu käynnistimen metatiedoksi. Koko tarkistetaan ennen
heksadekoodausta. Virhe sulkee parserin pysyvästi, eikä poikkeus toista
hylättyä sisältöä. Osittainen viimeinen rivi hylätään.

Latauskuitti sisältää lukitut laskentarajat ja template-tarkisteen. Virheiden
vaiheavaimet ovat `runtime-load`, `model-load`, `template-identity`,
`model-context`, `input-invalid`, `input-tokens`, `generation-failed`,
`cancelled` ja `internal`. Natiivisovitin mapittaa omat poikkeuksensa näihin;
DLL-nimiä tai vapaata WinError-tekstiä ei lähetetä vaiheavaimena.

## Aikakatkaisu ja hyväksynnän portti

Jaettu `MODEL_TIME_BUDGET` malliviestisopimuksessa määrittää omistajalle
180 sekunnin kokonaistyön: myös valmistelu ja siivous kuuluvat siihen.
Backend odottaa tulosta 185 sekuntia ja pyytää sen jälkeen peruutusta.
Peruutuskuittausta odotetaan vielä enintään 10 sekuntia. Nämä ovat
virhetilan ylärajat, eivät vasteaikatavoitteita.

Backend ei vapauta mallijonoa ensimmäisessä aikakatkaisussa. Jos omistaja
kuittaa lopputuloksen, aikakatkaistu työ palautuu TIMEOUTina. Jos kuittausta
ei tule tai kanava katkeaa, sovitin suljetaan pysyvästi; jonosta ei käynnisty
uutta mallityötä epävarman vanhan rinnalle. Uusi initialize ei elvytä sitä.
Uusi backend-istunto tarvitsee uuden sovittimen.

Seuraavan main-sovittimen lopputulos saa hyväksyä uuden työn vasta, kun
malli on päättynyt, Job on tyhjä, profiili poistunut, brokerin poistuminen
varmistettu ja omistettu valmisteluhakemisto siivottu. Parserin hyväksymä
`done` tai `result` ei yksin riitä. Puuttuva kuitti tai epävarma pakkosulku
sulkee ajotavan; automaattista tavalliseen ajoon vaihtoa ei tehdä.

## Näyttö ja jäljellä oleva työ

T09j:n kevyet testit kattavat väärän istunnon, kehys-/tavu-/jonorajat,
osittaisen viestin, sulkuvahdin riippumattomuuden, UTF-8:n ja surrogaatit,
väärennetyn elinkaaritekstin, suljetut virheavaimet sekä jonon odotuksen ja
sovittimen pysyvän sulun. Windowsin transport-koe sisältää myös omistajan
katoamisen valmistelun aikana. Tarkat osatulokset ovat #10:ssä ja raakadata
paikallisessa `.artifacts/tests/`-puussa.

Natiivin dynaaminen syöte ja template-renderöinti, 4 096 kontekstin oikea
malliajo, myöhäisen peruutuksen kilpailutilanteet, mainin varsinainen
prosessisovitin, UI/MCP-yhteistoiminta ja siivouskuittien hyväksyntä ovat
vielä toteutettavia tai kokeella varmennettavia. Tämä perusta ei sulje #10:tä.
