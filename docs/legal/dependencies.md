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

Paikallisten mallien painoja tai node-llama-cpp:tä ei ole vielä asennettu.
Niiden kokeeseen valitut lisenssit ja alkuperät ovat
[mallikokeen manifestissa](../../tests/evaluations/local-model/pilot-manifest.json).
Tämä koonti ei valitse projektin oman lähdekoodin lisenssiä.
