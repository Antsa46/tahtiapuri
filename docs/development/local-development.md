# Paikallinen kehitys Windowsissa

Tämä ohje omistaa asennus- ja ajokomennot. Rungon vastuut ja IPC-sopimus
ovat [runkosuunnitelmassa](../architecture/initial-skeleton-plan.md).
Kehityskäynnistin tukee Windows x64:ää; muiden alustojen ajettavuutta ei ole todennettu.

## Asennus ja käynnistys

Suorita Tähtiapurin projektijuuressa PowerShellissä:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 models:prepare
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 start
```

Nykyinen main-entrypoint tarvitsee lisäksi erikseen rakennetun natiivin CPU-runtimen.
Sen edellytykset ja komento ovat [natiivin kehitysvaiheessa](#natiivin-cpu-sovittimen-kehitysvaihe).
Yllä oleva build ei rakenna sitä.

ExecutionPolicy-valinta koskee vain käynnistettyä PowerShell-prosessia.
Skripti hankkii tarkistettuun julkaisuun sidotun Node-työkalun, pnpm:n
sekä Electron-runtimen projektin .local/toolchain/-puuhun.
Yleistä Node-asennusta tai pysyviä PATH-asetuksia ei muuteta.
install hankkii myös lukitun node-llama-cpp:n valmiit Windows-binäärit;
asennusskriptejä tai lähdekäännöstä ei ajeta. Vulkan-pakettia ei asenneta.

models:prepare on erillinen verkkovalmistelu. Se hankkii vain hyväksytyn
Qwen3-4B Q4_K_M -GGUF:n ja lisenssin .local/models/-kansioon; noin 2,50 GB.
[Profiili](../../resources/models/qwen3-4b.json) lukitsee revision ja tarkisteet.
Olemassa oleva tiedosto tarkistetaan uudelleen. Kesken jäänyttä .part-tiedostoa
ei käytetä; poista kyseinen keskeneräinen tiedosto ennen uutta valmistelua.
build ja start eivät lataa mallia, binäärejä tai käännä natiivimoottoria.
8B:n valmistelu kuuluu alla kuvattuun erilliseen vertailuun.
Asetusten mallikansiovalitsin ei vielä kuulu runkoon.

Kehityksen natiivi main-entrypoint tukee nyt CPU:ta; CUDA-pyyntö hylätään.
Ensimmäinen kysymys tarkistaa ja lataa mallin. Jokainen natiivin sovittimen
työ saa tuoreen prosessin, joka sulkeutuu työn jälkeen. Asetusten ajotapavalinta
on vielä jatkotyötä. Vanha SDK:n CPU-/CUDA-polku säilyy erillisissä
koefixtuureissa; sen taustan vaihto sulkee vanhan työntekijän ennen uuden
käynnistystä. CUDA- tai eristysvirhe ei aktivoi varareittiä.
Jokainen kysymys on vielä itsenäinen, ilman keskusteluhistoriaa.
Malli ei vielä saa todellista säätä tai tähtilaskennan tietoja.

## MCP-kehitysyhteys

Asetusten Kehitystyökalut-osassa voi sallia rajatun kehitysyhteyden.
Se on pois jokaisessa käynnistyksessä. Stdio-sovitin, kolme työkalua,
asiakkaan erillinen määritys ja uudelleenkäynnistys on kuvattu
[MCP-käyttöohjeessa](mcp.md). Sovellus ei muuta Codexin asetuksia.

## Valinnainen CUDA-valmistelu

SDK-kontrollifixtuurin CUDA-ajo tarvitsee yhteensopivan NVIDIA-ajurin lisäksi paikalliset cuBLAS- ja
cudart-kirjastot:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 cuda:prepare
```

Skripti tarkistaa NVIDIA-arkistojen SHA-256:t ja purkaa ne vain
.local/toolchain/cuda/-puuhun. Se ei asenna ajuria, koko CUDA Toolkitia tai
muuta järjestelmän asetuksia. Main välittää tunnetut bin/x64-hakemistot
vain SDK-mallityöntekijän PATHiin. CPU-ajo ei tarvitse tätä valmistelua.
CUDA-valmistelu ei ota CUDA:a käyttöön natiivissa CPU-sovittimessa.
Tarkat CUDA-versiot ja toimituksen avoin fuse-ehto ovat
[moottorikokeen raportissa](../experiments/model-runtime-probe.md).

Tarkat työkalut ja julkaisijatarkisteet ovat
[scripts/dev/toolchain.json](../../scripts/dev/toolchain.json),
[package.json](../../package.json) ja [pnpm-lock.yaml](../../pnpm-lock.yaml).
Paketit asentuvat node_modules/-puihin, pakettivarasto .local/cache/pnpm/-puuhun.
pnpm 12 lukee nämä asetukset pnpm-workspace.yaml:stä; stateDir välitetään
kehityskäynnistimen prosessiympäristössä. .npmrc sisältää vain rekisteri-/TLS-asetukset.
Asennin käyttää olemassa olevaa lockfileä frozen-lockfile-tilassa.
Riippuvuuksien tarkoitukset ja lisenssit ovat [riippuvuuskoonnissa](../legal/dependencies.md).

## Tarkistukset

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 typecheck
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 test:e2e
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 test:model
```

typecheck tarkistaa backendin, main/preloadin, käyttöliittymän ja testit.
build kääntää Node-kohteet TypeScriptillä ja käyttöliittymän Vitellä;
testit eivät sisälly tuotannon käännökseen. test ajaa Vitestin.
test:e2e rakentaa erilliset testikäynnistimet ja ajaa rungon regressiot
todellista Electronia vasten ilman GGUF-mallin lataamista.

test:model on erillinen oikea 4B-moottorikoe: CPU ja CUDA, peruutus,
virhepolut sekä prosessien sulku. Se vaatii models:prepare- ja
cuda:prepare-valmistelut sekä yhteensopivan NVIDIA-ajurin; puuttuva CUDA
ei ohita testiä onnistuneena. Testit käyttävät yhtä työntekijää ja nollaa uusintaa.
GitHub-/etä-CI:tä ei ole.

Testit käyttävät omia datajuuria artefaktipuun sisällä.
Virhetilat, apulapsen instrumentointi ja testipreload ovat vain tests/e2e/-puussa.
Tuotannon IPC:ssä tai asetuksissa ei ole testitilaa.
Playwrightin tilapäiset debug-yhteydet kuuluvat testiajuriin.
Kehitysajo toimii tavallisen käyttäjän oikeuksilla; testaus ei osoita OS-verkkokieltoa.

## Paikallinen tähtilaskenta

T06:n offline-katalogi toimitetaan resources/catalogs-puussa. Tavallinen
build tai ajo ei lataa sitä. Test-komento sisältää JPL/ERFA-vertailut,
UTC/DST-reunat ja katalogin eheyden. [Laskentasopimus](../architecture/sky-calculation.md)
kuvaa yksiköt ja rajat. [Tähtikartta](../architecture/sky-map.md) toimii
ilman kielimallia: lisää havaintopaikka ja IANA-vyöhyke Havaintopaikat-asetuksissa.
Tallenna ja käytä paikkaa avaa kartan; seuraava käynnistys muistaa valinnan.
Kartan oma lomake vaihtaa paikallisaikaa ja UTC-poikkeamaa.
[Tallennussopimus](../architecture/observing-places.md) omistaa JSONin ja virhepolut.
test:e2e sisältää kartan valinnan, ajan/paikan vaihdon, resurssirajan ja
puuttuvan katalogin kokeet sekä paikkojen restart-/tallennusvirhepolut. Kuvakaappaukset jäävät .artifacts/tests/e2e/-puuhun.

## Erillinen 4B/8B-laatuvertailu

Vain vertailua varten valmistele myös hyväksytty noin 5,03 GB:n 8B-paino:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 models:prepare:8b
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 test:compare:smoke
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 test:compare
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 comparison:report
```

Nämä ovat erikseen käynnistettäviä hitaita malliajoja, eivät osa tavallista
test-komentoa. Ne vaativat myös yllä kuvatun CUDA-valmistelun ja NVIDIA-ajurin.
smoke sisältää vain katsauksen per malli/tausta; täysi ajo sisältää 96 vastausta
ja 12 lämmittelyä. Aja yksi vertailu kerrallaan. Tuotannon UI käyttää edelleen 4B:tä.
comparison:report päättyy koodiin 2, jos sarja tai käsinarviointi on kesken;
se ei täytä puuttuvia arvioita. Tulos on paikallisessa aikaleimatussa ajokansiossa.
[Vertailun menetelmä](../experiments/model-comparison.md) määrittää mittarien ja
käsinarvioinnin merkityksen.

## Tiedostot ja vian selvitys

- Sovellusten käännökset: apps/*/dist/ ja packages/*/dist/.
- Mallipainot ja niiden lisenssi: .local/models/.
- Testiraportit ja kuvakaappaukset: .artifacts/tests/.
- Mallikokeen vastaus- ja sulkunäyttö: .artifacts/tests/model/.
- Testikäynnistimien käännökset: .artifacts/tests/e2e-build/.
- Yksityinen kehityskonteksti ja työkalumuistiinpanot: .tahtiapuri-local/.
  [Yksityisyyslinja](../privacy/publication.md#paikallinen-kehityskonteksti) omistaa käytännön.
- Kehityssovelluksen Chromium-data: .local/data/desktop/.
- Tallennetut havaintopaikat: .local/data/desktop/observing/places.json.
- Myöhemmän 4B/8B-laatuvertailun syötteet: tests/evaluations/local-model/.

node_modules/, dist/, .local/, .tahtiapuri-local/ ja .artifacts/ on rajattu Gitistä.
Älä julkaise generoituja raportteja tai datajuuria sellaisenaan.
Rungon käynnistysvirhe päättää prosessin virhekoodiin 1 ja main siivoaa
omistamansa prosessit. Mallivirhe näkyy UI:ssa. Uusi yritys sallitaan vain
varmistetusti siistiytyneen työn jälkeen. Natiivin sovittimen protokollavirhe
tai epävarma sulku sulkee ajotavan pysyvästi; jäljelle jäänyt työtila estää
uuden ajon myös seuraavassa käynnistyksessä.
[Natiivin sovittimen sopimus](../architecture/native-model-runtime.md#aikakatkaisu-peruutus-ja-sulku)
omistaa tämän sulkuportin. Sovelluksen sulkeminen sulkee backendin ja mallityöntekijän.
Paketoitu asennin ja koko sovelluksen OS-oikeusrajat testataan myöhemmissä työpaketeissa.


## Natiivin CPU-sovittimen kehitysvaihe

Kehityksen main-entrypoint käyttää natiivia CPU-hostia. Malliruntime
rakennetaan erikseen `scripts/native/build-model-runtime.ps1`-komennolla
olemassa olevan, hyväksytyn lähdekäännöksen päälle. Se ei käännä koko
llama.cpp:tä uudelleen tai lataa mallia.
[Natiivin sovittimen sopimus ja rajatut koekomennot](../architecture/native-model-runtime.md)
kuvaavat valmistelun, normaalin vastauksen, peruutuksen ja Electron-/MCP-kokeet.
Puuttuva runtime ei aktivoi SDK-/CUDA-varareittiä automaattisesti.
Mallitiedosto pysyy erillisessä paikallisessa mallikansiossa.
