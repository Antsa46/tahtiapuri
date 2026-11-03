# Ensimmäinen 4B-malliajo Electronissa

T03 / issue #4, 3.11.2026.
Tämä raportti omistaa toteutuneen moottorikokeen näytön ja sen rajat.
[Alkuperäinen 4B/8B-koesuunnitelma](model-pilot.md) ja sen manifesti säilyvät
vertailun lähtötietoina. T03 ei ole vielä T04:n laatu- tai suorituskykyvertailu.

## Toteutunut kokoonpano

- Windows x64, Electron 45.2.1, node-llama-cpp 3.22.2.
- Julkaisun natiivipakettien metadata: ggml-org/llama.cpp, release v0.7.0.
  Tarkat paketti-integriteetit ovat pnpm-lock.yaml:ssä.
- Qwen3-4B Q4_K_M, 2 497 280 256 tavua; Qwenin GGUF-revisio
  bc640142c66e1fdd12af0bd68f40445458f3869b.
  [Hyväksytty profiili](../../resources/models/qwen3-4b.json) sisältää SHA-256:n,
  chat-templaten tarkisteen ja Apache-2.0-lisenssilähteen.
- CPU ja CUDA valitaan erikseen. CUDA ei vaihdu virheessä huomaamatta CPU:ksi.
  Laitekokoonpano ja ajotiedot säilyvät paikallisina.
- Valinnainen, projektikohtainen CUDA-redistrib 13.1.0:
  cuBLAS 13.2.0.9 ja cudart 13.1.80. Lähteet ja ZIP-tarkisteet ovat
  [työkalulukossa](../../scripts/dev/toolchain.json). GPU-ajuria tai
  järjestelmän CUDA-asennusta ei muutettu.
- Konteksti 4096, tulostus enintään 512 tokenia, temperature 0 ja seed 42.
  Jokainen kysymys saa uuden kontekstin; keskusteluhistoriaa ei vielä liitetä.
  T03 käyttää lyhyttä keskusteluohjetta, ei T04:n JSON-päätöskoetta.

GGUF ja lisenssi tarkistettiin paikallisesti ennen käyttöä. Sovitin tarkistaa
tiedostokoon, koko SHA-256:n, SDK-version ja upotetun chat-templaten jokaisen
uuden mallityöntekijän latauksessa. Painot, työkalut ja tulokset jäävät
projektin Gitistä rajattuihin .local/- ja .artifacts/-puihin.
8B-painoja ei tässä vaiheessa ladattu tai ajettu.

## Mitä oikeasti testattiin

Paikallinen test:model-ajo läpäisi seitsemän tapausta ilman uusintoja:

1. Oikea 4B-vastaus käyttöliittymän kautta CPU:lla; todellinen ajotausta varmistettiin.
2. Sama synteettinen kysymys CUDA:lla; todellinen ajotausta varmistettiin.
3. Peruutus ensimmäisen SDK:n tuottaman tekstikatkelman jälkeen, seuraavan
   työn onnistuminen ja perutun työn pysyminen peruttuna.
4. Hallittu OUT_OF_MEMORY-polku testityöntekijällä; lisäksi yksikkötesti
   luokittelee SDK:n aidon InsufficientMemoryError-poikkeustyypin.
   Fyysistä RAM-/VRAM-muistia ei kulutettu tarkoituksella loppuun.
5. Oikean GGUF-tiedoston hylkääminen väärällä odotetulla tarkisteella.
6. Omistetun mallityöntekijän kaatuminen, UI:n säilyminen käytettävänä,
   uuden työntekijän käynnistys ja sulku kesken latauksen.
7. SDK:n aidon testBindingBinary.js-apulapsen poistuminen Electron-mainin
   äkillisen kaatumisen jälkeen. Testi pidättää start-viestin, jotta
   odottava apulapsi varmasti on elossa kaatumishetkellä.

Molemmat varsinaiset vastaukset olivat: ”Jupiterin korkeus on 36,5 astetta.
Pilvisyys on 20 %.” Arvot annettiin kysymyksessä; ne eivät ole tämän illan
tähtilaskentaa tai ennustetta. Nämä ovat yhden lyhyen vastauksen
toimivuusnäytteitä. Konekohtaiset viive- ja muistihavainnot säilyvät
paikallisissa artefakteissa.

Ajantasaiset testimäärät ja katselmustulos kirjataan issueen. Paikalliset
raakavastaukset, kuvakaappaukset ja prosessikokeen tulos ovat
.artifacts/tests/model/-puussa, Playwright-koonti .artifacts/tests/model.json.
Yksikkötestit kattavat myös jonon rajat, myöhäiset tulokset, aikakatkaisun
sekä suljetun viestikanavan alustus- ja peruutuspolut.

## Windowsin SDK-apulapsi ja toimituksen avoin ehto

Julkinen getLlama toimii todetusti omassa UtilityProcessissa.
SDK testaa Windowsin GPU-binääriä väliaikaisessa node:child_process.fork-lapsessa.
Electronin UtilityProcess ei aseta sille main-prosessin tavoin Node-ajotapaa.
Sovitin asettaa siksi ELECTRON_RUN_AS_NODE=1 vain getLlama-alustuksen ajaksi
ja palauttaa aiemman arvon finally-lohkossa. SDK:n tiedostoja ei muuteta.

Ratkaisu tarvitsee Electronin RunAsNode-fusen tuen. Paketoidun sovelluksen
fusevalinta ja SDK-apulapsen toimivuus ovat T15/T16:n avoin toimitusehto;
kehitysajo ei todista niitä. Samoin native-moduulit ja NVIDIA-DLL:t on
toimitettava oikeina tiedostoina ja lisenssi-ilmoituksineen.
llama-server-varatoteutusta ei tarvita tähän toimivaan kehityskokeeseen.

## Aliriippuvuuden audit ja rajattu poikkeama

Ensimmäinen npm-audit ilmoitti node-llama-cpp:n simple-git 3.36.0 /
argv-parser 1.1.1 -ketjusta neljä tunnettua ilmoitusta (2 critical, 2 high).
SDK:n Git-kloonaus-/patch-polut eivät kuulu tähän build:never-ajotapaan,
eikä renderer tai malli voi antaa niille argumentteja.

Haavoittuvaa versiota ei silti jätetty käyttöön. pnpm-workspace.yaml lukitsee
vain node-llama-cpp 3.22.2:n simple-git-aliriippuvuuden versioon 4.0.2.
Se käyttää argv-parser 2.0.1:tä. Tämä on projektin rajattu major-override,
ei SDK-julkaisijan oma versiolupaus. Importit ja 4B:n oikeat CPU-/CUDA-
sekä elinkaariajot tarkistetaan korjatulla lukituksella; SDK:n Git-
rakennuspolkuja ei avata tämän poikkeaman takia.

Lähteet: [simple-git-ilmoitus ja korjattu versio](https://github.com/advisories/GHSA-x6jw-m9v5-85vh),
[argv-parser-ilmoitus](https://github.com/advisories/GHSA-v5rq-49vh-5v5c) ja
[asennetun julkaisun metatieto](https://registry.npmjs.org/simple-git/4.0.2).
Ajantasainen audit-tulos kirjataan issueen; nollatulos ei todista
natiivimoottoria tai sovellusta haavoittumattomaksi.

## Turvarajan tila

Main omistaa mallityöntekijän, backend jonon ja renderer vain nimetyt IPC-kutsut.
Lataus, verkkohaku, lähdekäännös, shell ja työkalujen suorittaminen eivät kuulu
mallin ajonaikaiseen rajapintaan. getLlama käyttää build:never,
skipDownload:true ja hyväksyttyjä valmiita binäärejä. Projektin valmistelu
hankkii erikseen vain tarkisteisiin sidotut riippuvuudet.

UtilityProcess ajetaan tavallisen käyttäjän oikeuksilla. Tämä ei ole
AppContainer/LPAC-eristys eikä todistettu OS-verkkokielto. T09 ja T16
säilyvät avoimina; todellinen sää, käyttäjähistoria ja yritysaineisto eivät
kuulu tähän kokeeseen. Mitattu apulapsen poistuminen ei todista kaikkia
jumittuneen natiivialustuksen skenaarioita.

## Lähteet

- [SDK:n Electron-ohje](https://node-llama-cpp.withcat.ai/guide/electron)
- [SDK:n CUDA-ohje](https://node-llama-cpp.withcat.ai/guide/CUDA)
- [Electron RunAsNode-fuse](https://www.electronjs.org/docs/latest/tutorial/fuses)
- [Electron 45.2.1:n Node-alustus](https://github.com/electron/electron/blob/v45.2.1/lib/node/init.ts)
  ja [UtilityProcess-alustus](https://github.com/electron/electron/blob/v45.2.1/lib/utility/init.ts)
- [NVIDIA CUDA 13.1.0:n redistrib-metatieto](https://developer.download.nvidia.com/compute/cuda/redist/redistrib_13.1.0.json)
