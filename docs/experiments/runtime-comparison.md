# Korjatun runtime-polun vertailun valmistelu

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

Ehdotus on kertaluonteinen Node 24.22.2 -lähdevertailu:

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

## Työkaluketjuehdotus — ei asennettu

Node 24:n virallinen ohje vaatii Windowsissa ClangCL:n. Tuettu vaihtoehto
on Build Tools for Visual Studio 2022 Current 17.14 tai Visual Studio 2026.
Ehdotettu 2022-kokoonpano on C++ build tools, MSVC v143 x64/x86,
Windows 11 SDK 10.0.26100 sekä seuraavat komponentit:

- Microsoft.VisualStudio.Component.VC.Llvm.Clang (luettelossa Clang 19.1.5)
- Microsoft.VisualStudio.Component.VC.Llvm.ClangToolset

Tarkat asentimen ja komponenttien revisiot lukitaan hankintavaiheessa.
Python valitaan Noden tukemasta versiosta käännösprosessin omalla PATHilla.
NASM voidaan jättää pois käyttämällä molemmissa koebuildeissa
openssl-no-asm-optiota; ero viralliseen binääriin kirjataan.

Build Tools ei ole pelkkä projektikansioon purettava työkalu: Installer,
jaetut komponentit ja osa SDK:sta kirjoittavat järjestelmäalueille myös
mukautettua asennuspolkua käytettäessä. Sen asennus tarvitsee erillisen
käyttäjäpäätöksen. Projektin lähteet ja tulokset pysyvät omissa paikallisissa
hakemistoissa. Käännöspolun välilyöntien tuki tarkistetaan erikseen;
projektia ei siirretä tai asemakytkentää luoda hiljaisesti.

Asennus vaatii useita gigatavuja latausta ja levytilaa; tarkka valinnan
koko saadaan asentimesta. Microsoftin Build Tools -vaatimus on valinnoista
riippuen 2,3–60 Gt, eikä sitä pidetä tämän rajatun valinnan kokomittauksena.
Käännöstuotokset tarvitsevat lisäksi omaa tilaa. Build Tools poistetaan
Installerista; pelkkä projektikansion poistaminen ei poista asennusta eikä
jaettuja komponentteja luvata automaattisesti poistuviksi.

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
