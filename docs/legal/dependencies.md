# Riippuvuudet ja lisenssit

Tämä koonti aloitettiin T02:ssa. Tarkat suorat versiot ovat
[manifesteissa](../../package.json), transitiiviset versiot ja julkaisuintegriteetit
[pnpm-lock.yaml:ssä](../../pnpm-lock.yaml). Taulukko ei ole lopullisen
asennuspaketin lisenssiliite. Se viimeistellään T17:ssä toimitetun sisällön perusteella.

| Riippuvuus | Käyttö | Julkaisun lisenssimerkintä |
| --- | --- | --- |
| Electron 45.2.1 | Desktop-runtime, ikkunat, preload ja UtilityProcess. | MIT; Chromium/Node ja muut mukana toimitetut osat omine ilmoituksineen. |
| React ja React DOM 19.3.1 | Paikallinen käyttöliittymä. | MIT |
| Vite 8.3.5 ja @vitejs/plugin-react 6.2.1 | Käyttöliittymän rakennus. | MIT |
| TypeScript 7.0.2 | Käännös ja tyypintarkistus. | Apache-2.0 |
| Vitest 5.1.0 | Paikalliset yksikkö- ja integraatiotestit. | MIT |
| @playwright/test 1.64.1 | Oikean Electronin E2E-testit. | Apache-2.0 |
| @types/node 24.10.0, @types/react ja @types/react-dom 19.3.0 | Käännösaikaiset tyypit. | MIT |
| node-llama-cpp 3.22.2 ja sen Windows CPU-/CUDA-binäärit | SDK-kontrollit ja paikallismallien vertailut. | MIT; binäärien mukana tulevat llama.cpp- ja muut ilmoitukset säilytetään. |
| llama.cpp v0.9.0 lähdekäännös, CPU | Natiivin CPU-mallisovittimen moottori; tarkka revisio, lähde ja rakennusprofiili resources/runtimes-puussa. | MIT; upstream LICENSE säilytetään. |
| llama.cpp b12110 CPU ja LLVM OpenMP | Alkuperäinen binääriverrokki latausdiagnoosissa. | MIT sekä mukana säilytettävä LICENSE-LLVM-OpenMP ilmoituksineen. |
| CMake 4.4.5 | Projektikohtainen natiivin CPU-moottorin rakennustyökalu. | BSD-3-Clause; doc/cmake/LICENSE.rst ja komponenttien ilmoitukset säilytetään. Ei sovelluksen runtime-riippuvuus. |
| Astronomy Engine 2.1.19 | Offline-efemeridit ja koordinaattimuunnokset sky-sovittimessa. | MIT |
| HYG Database 4.1, johdettu 5 070 tähden aineisto | Paikallinen mag≤6-katalogi. | CC BY-SA 4.0; lähde, muutokset ja aineistolisenssi resources/catalogs-puussa. |
| @modelcontextprotocol/server, client ja core 2.4.0 | Rajattu stdio-palvelin sekä oikean asiakkaan integraatiotestit. | Apache-2.0 |
| Zod 4.6.7 | MCP-työkalujen syöteskeemat. | MIT |
| simple-git 4.0.2 ja argv-parser 2.0.1 | SDK:n transitiivinen Git-kirjasto, rajattu turvallisuuspäivityksen override. Rakennuspolku ei käytössä malliajossa. | MIT |
| Qwen3-4B ja Qwen3-8B Q4_K_M GGUF | Paikallinen keskustelumalli ja erillisen vertailun 8B-paino. | Apache-2.0; tarkka revisio ja LICENSE-tarkiste malliprofiilissa. |
| NVIDIA cuBLAS 13.2.0.9 ja CUDA Runtime 13.1.80 | Valinnainen CUDA-tausta; projektikohtaiset DLL:t. | NVIDIA CUDA Toolkit -lisenssi ja komponenttien mukana toimitetut LICENSE-tiedostot. |
| Node 24.22.2 ja pnpm 12.16.1 | Projektikohtainen kehitystyökaluketju. | MIT; mukana toimitettujen osien omat ilmoitukset säilytetään. |

Lähteenä käytetään kunkin lukitun npm-julkaisun package.json/LICENSE-tiedostoja.
Julkaisut löytyvät [npm-rekisteristä](https://registry.npmjs.org/) täsmällisellä
pakettinimellä ja versiolla; runtimearkistot tulevat
[Node-julkaisusta](https://nodejs.org/dist/v24.22.2/) ja
[Electron-julkaisusta](https://github.com/electron/electron/releases/tag/v45.2.1).
Elektronin arkistossa säilytetään LICENSE ja LICENSES.chromium.html.
pnpm:n omat THIRD-PARTY-NOTICES-ilmoitukset säilyvät työkalun mukana.

Electron kuuluu toimitettavaan runtimeen, vaikka npm-paketti on
devDependencies-kohdassa. Reactin ja sen aliriippuvuuksien koodi päätyy
UI-buildiin. Myös näiden ilmoitukset huomioidaan toimituksessa.
Muut yllä mainitut työkalut eivät automaattisesti kuulu loppukäyttäjän pakettiin.
Rungolle ei ole vielä tehty asennuspakettia.

T03:ssa node-llama-cpp ja yksi 4B-malli on asennettu projektin omaan puuhun.
Mallin alkuperä, lisenssilähde ja tarkiste ovat
[hyväksytyssä profiilissa](../../resources/models/qwen3-4b.json).
NVIDIA-komponentit ovat virallisen CUDA 13.1.0 -redistrib-julkaisun
ZIP-arkistoista; versiot, lähde ja SHA-256:t ovat
[työkalulukossa](../../scripts/dev/toolchain.json). Molempien arkistojen
LICENSE säilyy puretun komponentin juuressa. Tämä ei oleta oikeutta
jakaa koko CUDA Toolkitia uudelleen; lopulliset jaettavat DLL:t,
soveltuvat ehdot ja ilmoitukset tarkistetaan toimituksen T17-katselmuksessa.
Ks. [NVIDIA CUDA Toolkit -lisenssi](https://docs.nvidia.com/cuda/eula/index.html).
Mallipainoja ei tässä projektissa sisällytetä asennuspakettiin.
Tämä koonti ei valitse projektin oman lähdekoodin lisenssiä.

SDK:n Git-aliriippuvuuden rajatun yliajon syy, lähteet ja tarkistusraja ovat
[moottorikokeen raportissa](../experiments/model-runtime-probe.md#aliriippuvuuden-audit-ja-rajattu-poikkeama).

T07:n kartta käyttää selaimen Canvas 2D -rajapintaa ja samoja HYG/Astronomy Engine
-resursseja. D3-Celestialia tai uusia kuva-/fontti-/katalogiriippuvuuksia ei
otettu käyttöön. Kartan aineistomerkinnät kuvataan [tähtikarttasopimuksessa](../architecture/sky-map.md).

Natiivin CPU-kokeen alkuperä, DLL-rajaus ja avoin MSVC-toimitusriippuvuus
kuvataan [koedokumentissa](../experiments/native-cpu-model-probe.md).


T09k:n natiivin sovittimen rakennus kopioi hyväksytyt neljä CPU-DLL:ää,
omat broker-/worker-binäärit ja llama.cpp:n LICENSE-tiedoston paikalliseen
runtime-toimitukseen. Mallipainot säilyvät erillisinä. Testien Jinja-vertailu
käyttää olemassa olevan SDK:n transitiivista @huggingface/jinja-riippuvuutta;
sitä ei lisätä natiivityöntekijään. MSVC-ajoympäristön toimitus ja sen ehdot
sekä lopullisen asennuspaketin lisenssiliite ovat edelleen avoimia.
