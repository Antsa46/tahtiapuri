# Paikallinen kehitys Windowsissa

Tämä ohje omistaa asennus- ja ajokomennot. Rungon vastuut ja IPC-sopimus
ovat [runkosuunnitelmassa](../architecture/initial-skeleton-plan.md).
Käytössä on Windows x64; muiden alustojen ajettavuutta ei ole todennettu.

## Asennus ja käynnistys

Suorita Tähtiapurin projektijuuressa PowerShellissä:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 start
```

ExecutionPolicy-valinta koskee vain käynnistettyä PowerShell-prosessia.
Skripti hankkii tarkistettuun julkaisuun sidotun Node-työkalun, pnpm:n
sekä Electron-runtimen projektin .local/toolchain/-puuhun.
Yleistä Node-asennusta tai pysyviä PATH-asetuksia ei muuteta.
Asennus tarvitsee verkkoyhteyden; rakennettu statusrunko käyttää paikallisia resursseja.
GGUF-malleja tai mallimoottoria ei vielä hankita.

Tarkat versiot ja julkaisijatarkisteet ovat
[scripts/dev/toolchain.json](../../scripts/dev/toolchain.json),
[package.json](../../package.json) ja [pnpm-lock.yaml](../../pnpm-lock.yaml).
Paketit asentuvat node_modules/-puihin, pakettivarasto .local/cache/pnpm/-puuhun.
pnpm 12 lukee nämä asetukset pnpm-workspace.yaml:stä; stateDir välitetään
kehityskäynnistimen prosessiympäristössä. .npmrc sisältää vain rekisteri-/TLS-asetukset.
Asennusskriptit on estetty; Electron-arkisto hankitaan ja tarkistetaan erikseen.
Asennin käyttää olemassa olevaa lockfileä frozen-lockfile-tilassa.
Riippuvuuden tarkoitus ja lisenssit kirjataan [riippuvuuskoontiin](../legal/dependencies.md).

## Tarkistukset

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 typecheck
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 test:e2e
```

typecheck tarkistaa backendin, main/preloadin, käyttöliittymän ja testit.
build kääntää Node-kohteet TypeScriptillä ja käyttöliittymän Vitellä;
testit eivät sisälly tuotannon käännökseen. test ajaa Vitestin.
test:e2e rakentaa myös erilliset testikäynnistimet ja ajaa Playwrightin
todellista Electronia vasten, yksi työntekijä ja ilman automaattisia uusintoja.
GitHub-/etä-CI:tä ei ole.

Testit käyttävät omia tilapäisiä datajuuria artefaktipuun sisällä;
sulku- ja kaatumiskokeissa sama datajuuri avataan uudelleen.
Virhetilat ja testipreload ovat vain tests/e2e/-puussa.
Tuotannon IPC:ssä tai asetuksissa ei ole testitilaa.
Playwrightin tilapäiset debug-yhteydet kuuluvat testiajuriin, eivät
sovelluksen normaaliin ajotapaan. Testaus ei osoita OS-verkkokieltoa.

## Tiedostot ja vian selvitys

- Sovellusten käännökset: apps/*/dist/ ja packages/*/dist/.
- Testiraportit ja kuvakaappaukset: .artifacts/tests/.
- Testikäynnistimien käännökset: .artifacts/tests/e2e-build/.
- Kehityssovelluksen Chromium-data: .local/data/desktop/.
- Mallikokeen versionoidut syötteet: tests/evaluations/local-model/;
  niiden varsinaisia malliajoja ei vielä tehdä tässä rungossa.

node_modules/, dist/, .local/ ja .artifacts/ on rajattu Gitistä.
Älä julkaise generoituja raportteja tai datajuuria sellaisenaan.
Jos käynnistys epäonnistuu, prosessi päättyy virhekoodiin 1 ja
main pysäyttää omistamansa backendin. Sovelluksen sulkeminen sulkee myös backendin.
Paketoidun asentimen testaus tehdään myöhemmässä työpaketissa.
