# Korjatun Node-/SDK-polun vertailu

Tämä jatkaa [SDK-koetta](sdk-isolation-probe.md) ja issuea #26.
Tila: **kokeella selvitettävä**. Node-/Electron-runtimen vaihtoa sovellukseen
tai oman runtime-haaran ylläpitoa ei ole päätetty.

## Erota kolme näyttöä

1. Oma Win32-putkinimiavaruuden diagnoosi nykyisellä natiivihostilla.
2. Samasta Node-lähteestä rakennettujen alkuperäisen ja korjatun version
   rajattu fork/IPC-vertailu.
3. Alkuperäisen SDK-apurin kontrolli/AC-matriisi: todellinen lapsi,
   hostin Job-/token-/SID-/capability-/IL-tarkistus, viisi tiedostokoetta,
   ready/loaded/done sekä normaali, virhe ja owner-loss.

Vain kohta 3 voi täyttää #26:n puuttuvan SDK-lapsinäytön. Node-apuprosessin
onnistuminen ei osoita Electronin oman Node-runtimen korjaantuneen.
#24:n verkko- ja LPAC-esteet sekä #10:n sovelluseristys säilyvät erillisinä.

## Rajattu Win32-diagnoosi

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\e2e\isolation\run.ps1 -Probe pipe
```

Koe käyttää nykyistä muuttamatonta natiivihostia ja omaa pipe-probe.cpp:tä.
Se ei lataa eikä käännä libuvia, Nodea tai SDK:ta. Tavallinen ja LOCAL-
putkinimi kokeillaan kumpikin kerran suojaamattomassa kontrollissa ja AC:ssa.
Kummassakin onnistuvassa putkessa kulkee synteettinen PING/PONG samaan
prosessiin kuuluvien kahden endpointin välillä. Etäasiakkaat hylätään.
I/O-odotus on rajattu; erillinen watchdog ja hostin Job katkaisevat jumin.
Kahvat suljetaan ennen tulosriviä; profiili ja staged-puu siivotaan.

Host tarkistaa pääprosessin täsmällisen Jobin, tokenin, SID:n ja perityt
kahvat ennen ResumeThreadiä. Tämä ei ole uusi lapsiprosessi-, tiedosto- tai
verkkorajan testi. Natiivikoettimen tulosrivit eivät ole riippumaton
hyökkäävän workerin todistus. SDK-kokeen erillistä kehystettyä protokollaa
ja lapsen host-tarkistusta ei korvata tällä.

Ajuri hyväksyy vain kontrollin kaksi onnistunutta roundtripiä ja AC:ssa
ordinary/create/ERROR_ACCESS_DENIED (5) sekä onnistuneen LOCAL-roundtripin.
Muu virhe, aikaraja tai puutteellinen siivous hylkää kokeen. Raakatulokset,
binääri-/lähdetarkisteet ja koetunnisteet jäävät .artifacts/-puuhun.

## Mitattu putkitulos

| Tapaus | Tavallinen nimi | LOCAL-nimi |
| --- | --- | --- |
| Suojaamaton kontrolli | PING/PONG onnistui | PING/PONG onnistui |
| AppContainer | CreateNamedPipe: ERROR_ACCESS_DENIED (5) | PING/PONG onnistui |

Molemmat ajot täyttivät pääprosessin token-/Job-/ACL- ja siivousehdot.
Kokeen ja ajurin poistumiskoodi oli 0. Omia prosesseja ei jäänyt, AC-profiili
poistui ja kumpikin staged-puu poistui ensimmäisellä yrityksellä.
AC:n LPAC-lisäkysely säilyi tuntemattomana (87); sitä ei tulkittu LPAC-näytöksi.

Tulos tukee upstreamin nimiavaruusselitystä. Se ei vahvista oman Node-forkin
natiivipinoa, korjattua libuv-käännöstä eikä alkuperäisen SDK-lapsen toimintaa.
#26:n hyväksymisehdot 2–3 pysyvät avoimina. Erillinen tarkastaja tarkisti
natiivikoettimen ja ajurin; löydetty watchdogin virhepolku korjattiin ennen ajoa.

## Runtime-ehdokkaan valinta

Tarkistuksessa 4.11.2026 virallinen Node-julkaisuindeksi ja uusimmat
Windows-nightly-merkinnät ilmoittivat edelleen libuv 1.52.1:n.
Node-projektin libuv 1.53 -päivitys oli avoin. Pelkkä uuden version lataus
ei siksi ole osoitettu korjattu vertailukohta.

Vertailu käyttää kertaluonteista Node 24.22.2 -lähdekäännöstä:

- Virallinen Node 24.22.2 on alkuperäinen julkaisuvertailu.
- Sama lähde rakennetaan ensin muuttamattomana ja sitten vain libuvin
  upstream-korjauksen 2cadaa40167050baf7c6905ac897e6fb57afb2c6
  src/win/pipe.c-muutoksella. Upstreamin muut CI-/testimuutokset eivät kuulu
  runtime-patchiin.
- Molemmissa paikallisissa käännöksissä käytetään samaa työkaluketjua ja
  samoja optioita. Virallinen ja oma käännös yksin eivät eristä patchin vaikutusta.
- Lähdearkisto, upstream-patch, tarkka sovellettu diff, työkalut, komennot
  ja kummankin binäärin SHA-256 kirjataan ennen ajoa.
- Hankinta ja käännös ovat erillinen valmisteluvaihe. SDK-kokeen aikana
  lataus ja rakentaminen pysyvät estettyinä.
- Node saa oman kiinteän image-/käynnistyssopimuksen; sitä ei nimetä
  electron.exe:ksi eikä Electronin ESM-guardia vain poisteta.

## Käännöksen työkalut ja rajaus

Rajattu Visual Studio Community 2022 -asennus sisältää C++-työkalut,
MSVC v143 x64/x86:n, Clang 19.1.5:n, ClangCL-toolsetin ja Windows SDK
10.0.26100:n. Mitattu asennusversio on 17.14.37827.9. Python 3.11.9
valitaan vain käännösprosessin ympäristössä. Asennus on kehitystyökalu;
sovelluksen käyttäjä ei tarvitse Visual Studiota mallin suorittamiseen.

Communityn yksittäisen kehittäjän lisenssi sallii omien sovellusten
kehittämisen. Build Toolsin avoimen lähdekoodin poikkeus ei yleisesti kata
riippuvuuden kehittämistä tai testaamista. Tässä muutetaan ja testataan
libuvia, joten pelkkää riippuvuuden kääntämistä koskevaa poikkeusta ei käytetä
lisenssiperusteena. Mahdollisen organisaatiokäytön ehdot arvioidaan erikseen.

Molempien paikallisten varianttien käännöskomento on sama:

```text
vcbuild.bat release projgen x64 vs2022 clang-cl openssl-no-asm nonpm nocorepack no-cctest
```

Käännösprosessissa `NUMBER_OF_PROCESSORS=2` ja
`msbuild_args=/m:1 /nodeReuse:false /p:MultiProcMaxCount=2
/p:EnforceProcessCountAcrossBuilds=true /p:UseMultiToolTask=true` rajaavat kuormaa.
Raja asetetaan MSBuild-ominaisuutena, koska Visual Studion ympäristö voi
korvata pelkän NUMBER_OF_PROCESSORS-arvon. PATH ja PATHEXT
asetetaan vain tätä prosessia varten. `release` ottaa tässä lähdeversiossa
käyttöön myös `--with-ltcg`-option. `openssl-no-asm` välttää erillisen NASM-
työkalun; omat koebinäärit eivät siksi vastaa virallisen julkaisun optimointeja.
Tämä ero on molemmille paikallisille varianteille yhteinen.

Lähteet, binäärit, valmisteluskriptit ja alkuperäiset epäonnistumiset
säilytetään projektin ohitetuissa paikallishakemistoissa. Lyhyt lähdepolku
välttää generoitujen tiedostojen Windows-polkurajan. Koneen yleistä
pitkien polkujen asetusta, PATHia tai asemakytkentöjä ei muuteta.
Asennin ja työkalut ovat järjestelmäasennus; niitä ei voi poistaa poistamalla
projektin kansiota. Uusi asennus voidaan poistaa Visual Studio Installerista,
mutta jaettujen komponenttien poistumista ei oleteta.

## Runtimen ja koekonsolin sopimus

`run.ps1 -Probe sdk -SdkRuntime official|local-unpatched|local-patched`
valitsee erillisen kiinteän Node-polun. Oletus `electron` säilyttää aiemman
Electron-kokeen. Node-varianttien versio- ja SHA-256-tiedot luetaan paikallisesta
`.artifacts/tests/t09c-node/runtimes.json`-manifestista. Puuttuva tai poikkeava
manifesti ei käynnistä koetta. Binääriä ei nimetä Electroniksi.

Guard tarkistaa binäärin tarkisteen, version, arkkitehtuurin, prosessikuvan
ja runtime-kohtaisen ympäristön ennen SDK-importtia. Electronilta vaaditaan
yhä `electron:electron`-ESM-resoluutio. Node-polku hylkää Electron-version,
ELECTRON_RUN_AS_NODE-tilan ja ylimääräiset NODE_OPTIONS/NODE_PATH-asetukset.
Sama SDK-lähde, CPU-binääri ja lapsiprotokolla säilyvät kaikissa varianteissa.
Koepaketin oma minimaalinen package.json katkaisee Node-pakettikontekstin
haun koepuun sisälle. Ilman sitä virallinen Node pysähtyi kahdesti
ERR_INVALID_PACKAGE_CONFIG-virheeseen yrittäessään lukea ylemmän projektin
manifestia. Alkuperäisiä SDK-manifesteja tai lähdeprojektin ACL-oikeuksia
ei tämän vuoksi muuteta. Epäonnistuneet ajot säilyvät erillisinä.

Node on konsolisovellus. Uuden piilotetun konsolin luonti lisäsi conhost.exe:n
kahteen prosessiin rajattuun Job-objektiin ja pysäytti kontrollin. Node-polku
käyttää siksi testihostin omaa piilotettua konsolia. Host varmistaa ennen
käynnistystä, että se on konsolin ainoa asiakas, konsoli ei ole näkyvä ja
konsoli-isäntä on sen oma yksikäsitteinen suora lapsi täsmällisessä Windowsin
järjestelmäpolussa. Konsoli-isännän prosessikahva pidetään poistumisen
varmistamista varten. Epäselvä omistajuus keskeyttää kokeen.

Jaettu koekonsoli on erillinen kommunikaatiopinta stdio-putkien lisäksi;
tämä ei ole tuotannon konsolieristyksen hyväksyntä. Rajoitetun Jobin
jäsenmäärää, prosessikuvia, tokeneita tai ACK-ehtoja ei lievennetä.
Normaali- ja virhepolulla host vapauttaa konsolin ja odottaa sen poistumisen.
Owner-loss-polulla omistajan viestireitti katkaistaan tarkoituksella, joten
ajuri vaatii konsolin tunnistamisen ennen katkaisua ja tarkistaa poistumisen
ulkopuolelta siivouksessa. Ajuri ei pakkotapa yleisiä järjestelmäprosesseja.

`run-node-fork.mjs` tekee ensin oman pienen PING/PONG-fork-kokeen ilman SDK:ta.
Sen tulos on vain runtime-/IPC-näyttöä. Varsinainen hyväksymisportti on edelleen
SDK:n koko kontrolli/AC-matriisi.

Vaihtoehto on odottaa korjauksen sisältävää virallista yhteensopivaa
runtimea. Bunin tai vanhan Node-version käyttö muuttaisi useampaa muuttujaa;
niitä ei oteta tämän vertailun korvikkeeksi. Tuotannon runtime-valinta
arvioidaan kokeen jälkeen erikseen.

## Lähteet

- [Node-julkaisuindeksi](https://nodejs.org/dist/index.json)
- [Node-nightly-indeksi](https://nodejs.org/download/nightly/index.json)
- [Noden libuv 1.53 -päivitys](https://github.com/nodejs/node/pull/66282)
- [AppContainer-forkin ongelma](https://github.com/nodejs/node/issues/66374)
- [Libuvin putkikorjaus](https://github.com/libuv/libuv/commit/2cadaa40167050baf7c6905ac897e6fb57afb2c6)
- [Node 24.22.2:n käännösohje](https://github.com/nodejs/node/blob/v24.22.2/BUILDING.md#windows)
- [Build Tools -komponentit](https://learn.microsoft.com/en-us/visualstudio/install/workload-component-id-vs-build-tools)
- [Asennuskohteiden rajat](https://learn.microsoft.com/en-us/visualstudio/install/change-installation-locations)
- [Build Tools -levytilavaatimus](https://learn.microsoft.com/en-us/visualstudio/releases/2026/vs-system-requirements#microsoft-visual-studio-build-tools-system-requirements)

- [Communityn lisenssiehdot](https://visualstudio.microsoft.com/license-terms/vs2022-ga-community/)
- [Microsoftin Visual Studio -lisenssiohje](https://www.microsoft.com/licensing/guidance/Visual-Studio)
- [Windowsin prosessinluontiliput](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)
- [Konsolin luonti ja periytyminen](https://learn.microsoft.com/en-us/windows/console/creation-of-a-console)
