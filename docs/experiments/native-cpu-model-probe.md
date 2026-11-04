# Natiivin CPU-mallin rajattu koe

T09:n osakoe liittää oikean 4B-mallin [natiiviin viestikanavaan](native-transport-probe.md).
Koe käyttää synteettistä vakiokysymystä ja erillisiä testiohjelmia. Electronin
nykyinen SDK-mallisovitin ei vaihdu tällä muutoksella. #10:n koko paketin,
verkon, backendin, MCP:n ja GPU:n hyväksyntä pysyy erillisenä.

## Moottori ja alkuperä

Koe lukitsee llama.cpp **v0.9.0** -lähderevision
`cd959bae99ff4bed22bef2604f45241c09bbb8c8`. Alkuperäinen virallinen
CPU-binääri **b12110** ja sen [tarkisteprofiili](../../resources/runtimes/llama-cpp-cpu.json)
säilyvät vertailuaineistona. Tavallinen prosessi tuotti sillä vakioidun
vastauksen. Nollan capabilityn LPAC-ehdokas pysähtyi DLL:n latausvaiheessa.
Rajattu diagnoosi paikansi Access denied -tuloksen myös DLL:n upotetun
manifestin aktivointikontekstin luontiin. Se ei yksilöinyt estettyä Windows-resurssia.
Oikeuksia ei laajennettu tämän virheen kiertämiseksi.

Uusi [lähdekäännösprofiili](../../resources/runtimes/llama-cpp-source-cpu.json)
käyttää samaa muuttamatonta upstream-lähdettä ja C-rajapintaa. Käännöksestä
poistetaan DLL-manifestit ja OpenMP; CUDA, RPC, palvelin ja komentorivityökalut
eivät kuulu siihen. Koepakettiin kopioidaan vain llama.dll, ggml.dll,
ggml-base.dll ja ggml-cpu.dll. PE-tarkistus edellyttää neljältä x64-DLL:ltä
resurssihakemiston puuttumista. Tämä eri rakennustapa ei yksin todista,
että alkuperäisen latausongelman ainoa syy oli manifesti.

Rakennus käyttää projektikohtaista, tarkisteella lukittua **CMake 4.4.5**
-työkalua ja olemassa olevaa MSVC-kääntäjää. Valmistelu tarkistaa ZIP-arkistot,
jokaisen puretun tiedoston ja ylimääräisten tiedostojen puuttumisen.
Reparse-kohteet ja arkiston polkupako hylätään. Windowsin pitkät lähdepolut
luetaan extended-polkuina. Rakennuksella on aina tuore, lyhyt yksityinen
hakemisto; järjestelmän polkuasetuksia ei muuteta. Lähde ja CMake tarkistetaan
ennen käännöstä ja sen jälkeen. Käytettyjen kääntäjän, linkkerin ja MSBuildin
tunnisteet, käskyt ja asetukset jäävät paikalliseen rakennuskuittiin.

Koesovittimien käännös tarkistaa kuitin, suljetun neljän DLL:n luettelon,
ABI-otsakkeet ja rakennusohjeiden tarkisteet. DLL-tarkisteista muodostetaan
käännöksen omistama otsake; niitä ei valita ajonaikaisesta käyttäjäsyötteestä.
DLL:t avataan täsmällisistä Unicode-poluista, ja riippuvuushaku rajataan
System32:een. CPU-tausta rekisteröidään jo avatusta kirjastosta, ei hakemistoa
skannaamalla. Todellinen laiteluettelo tarkistetaan.

Lähdekäännös käyttää Windowsin olemassa olevaa MSVC-ajoympäristöä.
Sen toimitus ilman erillisasennuksia, jakeluehdot ja lopullinen DLL-sulkeuma
on vielä ratkaistava paketoidun sovelluksen yhteydessä. Koe ei osoita
valmiin asentimen riippumattomuutta koneen muista asennuksista.

## Omistus, kuorma ja identiteetti

Luotettu käynnistäjä ja synteettinen kuljetuskoe jakavat
`native/isolated-launcher.h`-toteutuksen. Komentoriviltä ei voi valita
mielivaltaista ohjelmaa, oikeusluetteloa tai muistirajaa; kokeen oma C++-entrypoint
kiinnittää ne. Nollan capabilityn LPAC-ehdokasta verrataan tavalliseen prosessiin.
Tunnettu tokenkyselyn null / 87 / 0 säilytetään epävarmana.

Jokainen ajo saa oman tavallisista tiedostoista kopioidun hakemiston.
Malli ja DLL:t lukitaan ilman kirjoitus- tai poistamisjakoa, ja niiden
koko SHA-256 tarkistetaan lukon aikana ennen työntekijän käynnistämistä.
Lukot säilyvät Jobin tyhjentymiseen ja profiilin siivoukseen asti.
Käännösmanifesti sitoo lähteet, koebinäärit, profiilit, syötteen ja ulkoiset
otsakkeet samaan näyttöön. Ajuri hylkää myöhemmin muuttuneet tiedostot.

Työntekijän Job sallii yhden prosessin ja suorittimen, BelowNormal-prioriteetin
sekä 6 GiB:n commit-rajan. Valmistelu tarkistaa samat kuormarajat ja vähintään
6 GiB vapaata muistia ennen raskaita vaiheita. Tämä ei varaa muistia eikä
takaa koneen lämpötilaa. Malli käyttää CPU:ta, yhtä laskentasäiettä,
512 tokenin kontekstia sekä 32 tokenin batch-/microbatch-rajaa.

Kolme tiedostokoetta tarkistavat yksityisen synteettisen tiedoston lukukiellon,
kirjoitussuojatun koetiedoston kirjoituskiellon ja oman scratch-tiedoston
luonnin. Viimeksi mainitun poistaa luotettu omistaja. Kirjoitussuojattu
koetiedosto jätetään lukitsematta, jotta hylkäys todentaa oikeudet eikä
pelkkää jakolukkoa. Tämä ei korvaa laajempaa tiedosto- tai verkkokoetta.

## Syöte, peruutus ja sulku

[Qwen3-4B Q4_K_M](../../resources/models/qwen3-4b.json) saa
[vakioidun suomenkielisen kysymyksen](../../tests/fixtures/native-cpu-prompt.json).
Syöte on renderöity lukitun GGUF:n chat-templatesta thinking pois kytkettynä.
Kokeen C++-vakio ja JSON-fixture tarkistetaan samoiksi. Mallin lataus tarkistaa
myös varsinaisen templaten tiivisteen. Tämä on yksi tarkoituksellinen
mallikohtainen fixture, ei yleinen template-moottori.

Greedy-generointi saa tuottaa enintään 16 tokenia. Normaalikoe edellyttää
luonnollista lopetusta ja täsmällistä vastausta Jupiter; se ei mittaa
yleistä tähtitiedettä, suomen laatua tai työkalukutsujen osaamista.

Yksi ohjaussäie lukee ja kirjoittaa kehystettyä kanavaa, toinen laskee.
Peruutus välitetään atomisella lipulla llama.cpp:n abort-callbackille.
Peruutus- ja kesken työn tehtävän sulun koe edellyttävät natiivin decoden
palauttamaa abort-tulosta. Laskentasäie yhdistetään ennen kontekstin ja mallin
vapautusta. Mallin omat lokit eivät kulje ohjauskanavassa.

Omistajan katoamiskoe katkaisee yhteyden mallin ollessa ladattuna ja työn
aloitussignaalin jälkeen. Se osoittaa elävien malliresurssien pakkosulun,
ei varmasti juuri sillä hetkellä suoritetun tensorilaskennan keskeyttämistä.
Puuttuvan mallin ja CPU-kirjaston kokeet edellyttävät täsmällistä
latausvirhettä ja siistiä sulkua ilman vaihtoehtoiseen ajotapaan vaihtoa.

## Ajaminen

Projektin olemassa olevat Windows C++-työkalut, lukittu Node ja hyväksytty
4B-mallitiedosto vaaditaan. Valmistelutyökalu hakee puuttuvat riippuvuudet
virallisista lukituista osoitteista; `-CheckOnly` vain tarkistaa ne.
Sovelluksen ajonaikainen verkkopolku ei osallistu valmisteluun.

~~~powershell
powershell -NoProfile -File tests/e2e/isolation/prepare-native-runtime.ps1
powershell -NoProfile -File tests/e2e/isolation/build-native-runtime.ps1
powershell -NoProfile -File tests/e2e/isolation/build-native-model.ps1
powershell -NoProfile -File tests/e2e/isolation/run-native-model-limited.ps1 -CheckOnly
powershell -NoProfile -File tests/e2e/isolation/run-native-model-limited.ps1 -Smoke
powershell -NoProfile -File tests/e2e/isolation/run-native-model-limited.ps1
node --test tests/e2e/isolation/native-model-results.test.mjs tests/e2e/isolation/transport-results.test.mjs tests/e2e/isolation/model-load-limits.test.mjs
~~~

`-ControlOnly` ja `-LpacOnly` rajaavat profiilin, ja ne ovat toisensa poissulkevia.
`-LoadCheck` kokeilee kirjastojen latauksen puuttuvalla mallilla ilman painojen kopiointia.
Kokeet ajetaan peräkkäin; ensimmäinen virhe pysäyttää matriisin.
Raakaraportit ja käännösnäyttö säilyvät Gitistä rajatussa
`.artifacts/tests/isolation/native-model/`-puussa. Moottorin rakennuskuitti on
`native-source-runtime/`-sisarhakemistossa ja lyhyt käännöspuu `.artifacts/b/`:ssä.
Mallit ja ladatut
riippuvuudet säilyvät `.local/`-puussa.

## Näytön tila

Lähteestä rakennettu CPU-moottori läpäisi täydellisen **12/12** sarjan:
kuusi tapausta tavallisessa prosessissa ja kuusi nollan capabilityn
LPAC-ehdokkaassa. Ennen sarjaa erilliset kirjastolatauksen ja oikean mallin
smoke-kokeet läpäisivät kumpikin **2/2**. Kohdistetut kevyet testit läpäisivät
**95/95**. Jokaisessa täyden sarjan tapauksessa omat prosessit, profiili ja
koehakemisto poistuivat; alkuperäinen mallitiedosto säilyi muuttumattomana.

Normaalivastaus oli täsmälleen Jupiter ja päättyi luonnolliseen EOS:ään.
Peruutus ja sulku kesken työn todensivat natiivin decoden abort-tuloksen.
Eristetyn prosessin tiedostokokeissa yksityisen tiedoston luku ja
kirjoitussuojatun tiedoston kirjoitus estyivät, oma scratch-kirjoitus onnistui.
Puuttuva malli ja kirjasto tuottivat odotetun virheen ilman varareittiä.

Riippumaton lähde-, rakennuskuitti- ja raakatuloskatselmus kuuluu hyväksyntään.
Verkkoyhteyksiä ei tässä kokeessa yritetty, ja `networkVerified` pysyy
false-arvossa. LPAC-tokenkyselyn epävarmuus säilyy. Eristetty CUDA,
valmiin sovelluksen prosessit sekä lopullinen paketti tarvitsevat oman näyttönsä.

Seuraava sovellusliitos tarvitsee mainin omistaman natiivisovittimen nykyisen
run/cancel/stop-portin taakse. Tämä koetyöntekijä hyväksyy vain yhden
vakioidun työn; se ei vielä toteuta vaihtuvaa keskustelusyötettä, usean työn
jonoa, UI/MCP-kontekstien erottelua tai sovelluksen nykyistä 4096 tokenin
sopimusta. Kokeen 512 tokenin asetusta ei ilmoiteta suuremmaksi kontekstiksi.

## Lähteet

- [llama.cpp v0.9.0](https://github.com/ggml-org/llama.cpp/releases/tag/v0.9.0)
- [Lukittu CPU-binäärijulkaisu b12110](https://github.com/ggml-org/llama.cpp/releases/tag/b12110)
- [Lukittu C-rajapinta](https://github.com/ggml-org/llama.cpp/blob/cd959bae99ff4bed22bef2604f45241c09bbb8c8/include/llama.h)

- [CMake 4.4.5](https://github.com/Kitware/CMake/releases/tag/v4.4.5)
