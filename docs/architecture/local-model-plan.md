# Paikallisen mallin kokeilu ja toimitus

Tämä on suunnitteluehdotus. Mallia tai moottoria ei ole valittu tai asennettu.
[Päätösten tila](../../README.md) omistaa valintojen hyväksynnän,
[turvallisuussuunnitelma](security-and-permissions-plan.md) yleiset oikeusrajat ja
[testausohje](../ai/testing-rules.md) arviointiaineistot ja tulosten raportoinnin.

## Suositus: vakaa rajapinta ensin, mallivalinta kokeilemalla

Oma mallirajapinta otetaan mukaan ensimmäiseen runkoon. Sen ensimmäinen
testitoteutus palauttaa vakioidun vastauksen. Oikea paikallinen moottori
liitetään varhain samaan rajaan. Käyttäjä vahvisti 4B- ja 8B-mallien
kokeilemisen ensin. Vertailukokoelmassa ovat myös sovitut Poro 2 8B
Instruct ja Ministral 3 8B Instruct kvantisoituina. Mallit arvioidaan
samoilla suomenkielisillä tehtävillä ja ajetaan vuorotellen.

Malli ei ole kovakoodattu käyttöliittymään tai käyttötapaukseen.
Käyttäjä valitsi mallin vaihtamisen myös sovelluksen asetuksista.
Oletusmalli valitaan vertailun perusteella; muiden hyväksyttyjen
mallipakettien käyttö säilyy mahdollisena.

## Mallien valinta asetuksista

Sovittu: käyttäjä voi valita asetuksista paikallisen mallin. Useita
hyväksyttyjä mallipaketteja voidaan säilyttää levyllä, mutta muistissa
pidetään yhtä mallia kerrallaan. Valinta kuuluu ohjelman omiin
asetustoimintoihin, ei avustajan tai MCP:n työkaluihin.
Käyttäjäpolku on [UC-08](../product/observing-session-use-cases.md#uc-08-paikallisen-mallin-valinta).

Ehdotettu toteutussopimus:

- UI näyttää käyttöön hyväksytyn malliluettelon, aktiivisen mallin ja
  lataustilan. Mallikansion ja uuden tiedoston käyttöönoton omistaa
  alla oleva mallikansiosopimus. Mallipyynnöt käyttävät tarkistettua
  tunnistetta, eivät mallin tai rendererin antamaa mielivaltaista polkua,
  latausosoitetta tai moottoriparametreja.
- Vaihto päättää tai peruu vanhan mallin tehtävät hallitusti ja vapauttaa
  sen prosessin, painot ja laskentakontekstin ennen uuden mallin latausta.
  Myöhästynyttä vastausta ei esitetä uuden mallin vastauksena.
- Uusi malli käyttää samaa rajapintaa, työkaluja ja käyttöoikeuksia.
  Keskustelun rajattu tekstikonteksti kootaan sen omalla chat-templatella;
  toisen mallin KV-välimuistia tai MCP:n kontekstia ei siirretä sille.
- Latausvirhe näkyy käyttäjälle. Kartta ja laskenta pysyvät käytettävissä;
  virhe ei käynnistä mallilatausta verkosta tai pilvimalliin siirtymistä.

Viimeksi valitun mallin muistaminen, käynnistyksen oletusmalli ja puuttuvan
mallipaketin käsittely ovat avoimia. Mallinvaihdon keskeytyskäytös
täsmennetään ennen toteutusta. Malliperheen vaihto ei itsessään lisää
agenttirooleja: aluksi käytetään yhtä opastajaroolia ja yhteistä työjonoa.
Sovelluksen mallivalinta kuuluu aloituskierroksen kohtaan 7; kehityksessä
käytettävien GPT-mallien työnjako kuuluu kohtaan 9.

## Paikallinen mallikansio

Sovittu suunta on pitää Tähtiapurin vertailupainot erillisessä paikallisessa
kansiossa. Asennin, tavallinen sovellusbuild ja sovelluspäivitys eivät
kopioi koko mallikokoelmaa. Painot hankitaan erikseen kehitysvaiheessa;
sovellus tai paikallinen malli ei lataa niitä verkosta. Moottorin
toimitus on tästä erillinen asia.

Ehdotettu asetustoiminto: käyttäjä valitsee paikallisen mallikansion
järjestelmän tiedostovalitsimella. Luotettu sovellusosa luettelee sen
GGUF-ehdokkaat. Uusi tiedosto ei käynnisty löytymisen tai tiedostonimen
perusteella, vaan se otetaan käyttöön vasta alkuperän ja yhteensopivuuden
tarkistamisen sekä käyttäjän valinnan jälkeen. Pelkkä .gguf-pääte ei takaa
moottorin, arkkitehtuurin tai chat-templaten tukea.

Malliprofiili yhdistää tunnisteen tiedostoon, lähtömalliin, kvantisointiin,
tarkisteeseen ja hyväksyttyyn chat-templateen. Tuetun mallin lisääminen
voi tapahtua ilman sovelluksen uudelleenpaketointia tai koodimuutosta.
Uusi arkkitehtuuri tai erikoinen työkalutemplate voi silti vaatia
moottorin tai sovittimen muutoksen. Mallikansion muistaminen,
tarkastustekniikka ja vaihdettujen tiedostojen käsittely täsmennetään.

Asetuksia muuttaa vain käyttäjä ohjelman omista valikoista.
Malli ja MCP eivät valitse kansiota tai hyväksy uusia painoja.
Tiedostorajojen omistaja on [turvallisuussuunnitelma](security-and-permissions-plan.md).
Puuttuva tai poistettu tiedosto näkyy virheenä; keskusteluja ei poisteta.
Ulkoinen mallikansio säilyy erillään käyttäjätiedon poistamisesta.

## Kvantisointi ja vertailun koko

Kvantisointi pienentää painojen esitystarkkuutta. Se ei vähennä mallin
parametrimäärää: esimerkiksi 14B säilyy noin 14 miljardin parametrin
mallina. Q4_K_M on pääosin 4-bittinen vaihtoehto. Tiedostokoko pienenee,
mutta laatu voi muuttua; nopeushyöty riippuu laitteesta ja ajotavasta.
[llama.cpp:n kvantisointiohje](https://github.com/ggml-org/llama.cpp/blob/master/tools/quantize/README.md)

Levylle mahtuminen ei todista ajon sujuvuutta. Painojen lisäksi muistia
tarvitsevat kontekstin KV-välimuisti, laskentapuskurit, Electron, backend,
käyttöjärjestelmä ja muut ohjelmat. RAM-/VRAM-kulutus, kontekstiraja ja
vasteaika mitataan omalla koneella jokaiselle ehdokkaalle.


## Rajapinnan vastuu

Backendin assistant-moduuli määrittelee tarvitsemansa portin.
Sovitin muuntaa omat tehtävä-, tulos- ja virhetyypit moottorin protokollaan.
Moottorin SDK, mallitiedoston polku ja palvelinkohtaiset asetukset eivät
vuoda käyttöliittymään, domainiin tai havaintokäyttötapauksiin.

- Tehtävällä on rajattu aineisto, vastaussopimus, konteksti- ja tulostusraja,
  aikakatkaisu sekä peruutus.
- Työkalukutsu on ehdotus. Backend tarkistaa työkalun nimen, argumentit,
  käyttäjän valitseman kontekstin ja kutsukiintiön ennen suorittamista.
- Työjono ajaa aluksi yhden tehtävän ja pitää yhden mallin ladattuna.
  Korjausyrityksiä on rajattu määrä; rajatonta agenttisilmukkaa ei synny.
- Mallimoottorin kaatuminen tai puuttuminen ei estä laskentakorttien käyttöä.
  UI kertoo mallin tilan. Sovellus ei siirry huomaamatta pilvimalliin.
- Main omistaa moottorin käynnistyksen ja sulun. Vain hyväksytty binääri,
  malli ja rajatut asetukset hyväksytään; renderer ei anna shell-komentoa
  tai mielivaltaista ohjelmapolkua.

## Ensimmäinen moottorikoe

Käyttäjä hyväksyi suunnittelulinjan: ensin arvioidaan node-llama-cpp:tä
erillisessä Electronin UtilityProcessissa käyttäen hyväksyttyä ulkoista
GGUF-mallia. Ensimmäinen näyttö on [rajattu mallikoe](../ai/testing-rules.md#ensimmäinen-tekninen-hyväksymiskoe).
TypeScript-sovitin ja rajattu viestiyhteys sopivat nykyiseen rakenteeseen.
Sovelluksen main omistaa prosessin elinkaaren; backendin assistant
omistaa tehtäväjonon, kontekstin ja työkalujen tarkistukset.
Sovitin ei anna rendererille mallimoottorin yleistä APIa.

Tämä on sovittu arviointisuunta, ei täsmäversion valinta tai todennettu
yhdistelmä. Suunnittelun hyväksyntä ei käynnistä asennuksia tai ajoja.
Electronin kokeellinen electron/llm näyttää vastaavan prosessijaon.
Sitä käytetään vertailuna, ei automaattisesti sovelluksen riippuvuutena.
Tarkat binäärit, CUDA-runtimet, ajurit ja paketoitu offline-käyttö
varmennetaan. Kehityksen lataus- ja käännösfallbackeja ei oleteta
sallituksi sovelluksen ajon aikana.
[Electronin vertailutoteutus](https://github.com/electron/llm),
[node-llama-cpp:n Electron-ohje](https://node-llama-cpp.withcat.ai/guide/electron),
[CUDA-ohje](https://node-llama-cpp.withcat.ai/guide/CUDA)

llama.cpp / llama-server erillisenä apuprosessina säilyy vaihtoehtona.
Sen rajattu paikallinen kuljetus, käytettävät reitit ja todentaminen
arvioidaan ennen valintaa. Mahdolliset yleiset agentti-, shell-, tiedosto-
tai verkkovälitystoiminnot eivät kuulu sovelluksen mallisovittimeen.
ONNX-pohjainen moottori voidaan arvioida erikseen; adaptereita ei
rakenneta etukäteen. Ollama ei ole tuotteen asennusvaatimus.

Prosessin erottaminen parantaa natiivikoodin virheistä palautumista;
se ei yksin rajaa OS-oikeuksia. Ajotavan ja eristyskokeen eron omistaa
[turvallisuussuunnitelma](security-and-permissions-plan.md#malliprosessin-ajotapa-ja-eristyksen-vaiheistus).
Mahdollinen kevyt CPU/GPU-yhteensopivuuskoe ilman AppContaineria on
erikseen rajattava kehityskoe, ei osoitus verkkokiellon täyttymisestä.
Koeympäristö ja sen oikeudet ovat vielä avoimia. Asennuksia tai ajoja
ei käynnistetä tämän suunnitelman perusteella.

## Moottorin tausta ja vertailuehdokkaat

llama.cpp on MIT-lisensoitu avoin ajomoottori. Taustalla on Georgi Gerganovin
ggml-kehitys ja yhteisö. ggml.ai ilmoittaa liittyneensä Hugging Faceen vuonna
2026; Hugging Facen ilmoituksen mukaan tiimi säilyttää teknisen johtonsa.
Moottorin valinta ei valitse mallin valmistajaa, pilvipalvelua tai painoja.
[ggml.ai](https://ggml.ai/),
[Hugging Facen ilmoitus](https://huggingface.co/blog/ggml-joins-hf)

Poro 2 8B Instruct ja Ministral 3 8B Instruct on sovittu vertailuun.
Käyttäjä vahvisti aloituksen 4B- ja 8B-malleilla. Suositus on Qwen3-perheen
4B/8B/14B-vertailu, jolloin sukupolvi ei vaihdu kokoluokan mukana.
Qwen3.5-4B jää erilliseksi myöhemmäksi ehdokkaaksi.
Tarkat Qwen-paketit, kvantisoinnit ja moottoribuild ovat avoimia.
Mitään mallia ei ole ladattu tai ajettu.

| Ehdokas | Tila ja kokeen tarkoitus | Avoin osa |
| --- | --- | --- |
| LumiOpen Llama-Poro-2-8B-Instruct | Sovittu: suomenkielinen keskustelu ja työkalutehtävät mitattavina. | GGUF-alkuperä, tarkka kvantisointi, chat-template, käyttöehdot ja oma arviointi. |
| Ministral 3 8B Instruct 2512 | Sovittu: eurooppalainen keskustelu- ja työkalumallin verrokki. | Tarkka GGUF ja kvantisointi; suomen kieli, faktat ja työkalut mitataan. |
| Qwen3-4B Q4_K_M | Ehdotettu toteutus sovitulle 4B-kokoluokan lisäykselle. | Suomen kieli, aineiston tulkinta, työkalut sekä CPU-/GPU-viive ja ajomuisti. |
| Qwen3-8B Q4_K_M | Ehdotus: saman perheen keskikokoinen vertailukohta. | Samat tehtävät ja asetusten kirjaaminen; paremmuutta ei oleteta. |
| Qwen3-14B IQ3_M tai Q3_K_M | Ehdotus: suurempi malli pienemmällä painotarkkuudella. Q4_K_M säilyy erillisenä vertailukohtana. | Todellinen VRAM, konteksti ja laatu mitataan. Pieni tiedostokoko ei takaa koko ajon mahtumista näytönohjaimelle. |

Tiedostokokoja tarkistettiin 3.11.2026: Qwenin oma 4B Q4_K_M on noin
2,50 GB, 8B Q4_K_M noin 5,03 GB ja 14B Q4_K_M noin 9 GB.
Bartowskin julkaisema 14B Q3_K_M on noin 7,32 GB ja IQ3_M noin
6,88 GB. Nämä ovat eri julkaisijan kvantisointeja, eivät Qwenin oman
GGUF-kokoelman tiedostoja. Alkuperä ja muunnosversio kirjataan erikseen.
Tiedostokoko on levytilaa, ei ajon RAM-/VRAM-lupaus.
[Qwenin 4B-tiedosto](https://huggingface.co/Qwen/Qwen3-4B-GGUF/blob/main/Qwen3-4B-Q4_K_M.gguf),
[8B-tiedosto](https://huggingface.co/Qwen/Qwen3-8B-GGUF/blob/main/Qwen3-8B-Q4_K_M.gguf),
[14B Q4_K_M](https://huggingface.co/Qwen/Qwen3-14B-GGUF/blob/main/Qwen3-14B-Q4_K_M.gguf),
[Bartowskin kvantisointitaulukko](https://huggingface.co/bartowski/Qwen_Qwen3-14B-GGUF)

Poro 2 Instruct on ohjeiden noudattamiseen jatkokoulutettu keskustelumalli.
Sen suomen kielen tai työkalukutsujen laatua ei päätetä etukäteen.
Samoin 4B:n välitön vastaus, Qwenin paras kokonaislaatu ja Ministralin
työkalujen paremmuus ovat koehypoteeseja, eivät tässä todennettuja tuloksia.
Skeemarajoitettu generointi voi auttaa JSON-muodossa tuetuilta osin;
se ei takaa oikeaa työkalua tai argumenttien merkitystä.
Backend tarkistaa molemmat ennen toimintoa.
[Poron mallikortti](https://huggingface.co/LumiOpen/Llama-Poro-2-8B-Instruct),
[llama.cpp:n vastausmuotojen tuki](https://github.com/ggml-org/llama.cpp/tree/master/tools/server)

Mistralin kyseinen Ministral 3 -perhe on Apache 2.0 -lisensoitu, ja valmistaja
julkaisee 3B- ja 8B-Instructista myös GGUF-versioita. Suomen kielen laatu on
meidän kokeellamme ratkaistava asia, ei yleisen monikielisyysväitteen seuraus.
[Mallikortti](https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512),
[valmistajan GGUF-kokoelma](https://huggingface.co/collections/mistralai/ministral-3-additional-checkpoints)

LUMI on supertietokone. Sen avulla koulutettu Poro 2 8B Instruct on
AMD Silo AI:n, TurkuNLP:n ja HPLT:n yhteistyötä sekä suomeen ja englantiin
suunnattu Llama-pohjainen keskustelumalli. Mallikortti ilmoittaa erilliset
Llama Community License -ehdot. Suomalaista jatkokehitystä ja koko
pohjamallin alkuperää ei pidetä samana asiana.
[Mallikortti](https://huggingface.co/LumiOpen/Llama-Poro-2-8B-Instruct)

Poron mallikortin ilmoittama Llama 3.3 Community License sallii suunnitellun
henkilökohtaisen käytön ja voi sallia myös EKYn kaltaisen yrityskäytön
ehtoja noudattaen. Kaupallisuus ei yksin sulje mallia pois. Tarkistetaan
valitun mallipaketin ehdot ja hyväksyttävän käytön säännöt; jakelussa
säilytetään vaaditut lisenssi- ja tekijämerkinnät sekä Built with Llama
-merkintä. EKYn oma mallivalinta ja käyttöönotto päätetään sen projektissa.
[Alkuperäinen lisenssi](https://github.com/meta-llama/llama-models/blob/main/models/llama3_3/LICENSE)

Poron tekijöiden raportoimat suomenkieliset testit tukevat mallin ottamista
vertailuun. Ne eivät ole oma mittauksemme tai suora vertailu nykyiseen
Ministraliin. Suomen luontevuus, tähtitiedon oikeellisuus ja työkalupyynnöt
arvioidaan samassa omassa tehtäväjoukossa.

## Mahdolliset lisäehdokkaat ja kevyempi kohdekone

Pienemmän EKY-kohdekoneen myöhempään arviointiin säilyvät alla olevat
vaihtoehdot. Ne eivät kuulu yllä ehdotettuun Tähtiapurin viiden mallin
kokoelmaan. Myös Ministral 3 14B on vaihtoehtoinen kokovertauskohde;
sen lisäämistä Qwen-vertailun rinnalle ei tarvita aluksi.

| Ehdokas | Miksi arvioitava | Avoin osa |
| --- | --- | --- |
| Qwen/Qwen3.5-4B | Kiinalaisen Qwen-perheen pienempi malli; julkaisijan kortti ilmoittaa Apache 2.0 -lisenssin ja työkalukutsutuen. | Suomen kieli, faktatuki ja työkalut testataan itse; valitun llama.cpp-buildin, GGUF:n ja chat-templaten yhteensopivuus varmennetaan. |
| google/gemma-4-E2B-it | Yhdysvaltalaisen Googlen paikalliseen ajoon suunnattu vaihtoehto; valmistajan kortti ilmoittaa Apache 2.0 -lisenssin. | E2B ei tarkoita koko painopaketin kahta miljardia parametria: kortissa on 2,3B tehokasta ja 5,1B embeddingit sisältävää parametria. Todellinen paketti ja ajomuisti mitataan. |

- [Qwenin mallikortti](https://huggingface.co/Qwen/Qwen3.5-4B)
- [Googlen mallikortti](https://huggingface.co/google/gemma-4-E2B-it)

Nämä ovat myöhempiä ehdotuksia, eivät asennuksia tai sovitun vertailun
laajennuksia. Valmistajan yleinen monikielisyys- tai agenttiväite ei todista
meidän tehtäviemme suomenkielistä laatua.

Tähtiapurin kehityskoneella tehty koe ei määrää EKYn oletusmallia.
Vähämuistiselle kohdekoneelle arvioidaan erikseen pieni kvantisoitu malli,
CPU-ajo, lyhyt rajattu konteksti ja yksi tehtävä kerrallaan. Kokonaismuistiin
kuuluvat myös käyttöjärjestelmä, Electron, backend ja muu sovelluskuorma.
Näytönohjaimen olemassaoloa, sen muistia tai sujuvaa ajoa ei oleteta.
Tämä on suunnitteluperiaate, ei todennettu hyväksyntä tietylle EKY-laitteelle.

## Moottorin julkaistujen turvatietojen arvio 2.11.2026

Tämä on lähdearvio, ei moottorin kattava koodiauditointi tai hyväksytty
asennusversio. Haavoittuvuuksien määrä tai mallin valmistajan kotimaa ei
yksin ratkaise ajon turvallisuutta. Arvioidaan käytetyt ominaisuudet,
korjaustila, toimitusketju ja käyttöjärjestelmän valvomat oikeudet.

| Tarkistettu tieto | Vaikutus tähän kokeeseen |
| --- | --- |
| CVE-2026-34159: tunnistamaton hyökkääjä voi suorittaa koodia erillisessä RPC-backendissä. Tiedote ei ilmoita korjattua versiota. | RPC-taustaa tai hajautetun laskennan rpc-serveriä ei tarvita eikä oteta käyttöön. Tämä RPC-palvelu on eri toiminto kuin mallin paikallinen HTTP-sovitin. |
| CVE-2026-33298: virheellisesti rakennettu GGUF voi aiheuttaa muistikorruption. Tiedote ilmoittaa korjatuksi versioksi b7824. | Mallitiedosto on turvarajan ylittävä syöte. Valitun moottoribuildin korjaustila ja mallin alkuperä tarkistetaan. |
| CVE-2026-116096: Pocket-TTS-/mmproj-polun muistikirjoitus; jakelun seuranta erottaa tarkistuskaatumisen rakenteellisesta korjauksesta. | Tekstipilotti ei tarvitse ääni- tai kuvaprojektoreita. Pelkkä uusin versio -väite ei ole todiste kaikkien polkujen korjauksesta. |

- [RPC-tiedote](https://github.com/ggml-org/llama.cpp/security/advisories/GHSA-j8rj-fmpv-wcxw)
- [GGUF-tiedote](https://github.com/ggml-org/llama.cpp/security/advisories/GHSA-96jg-mvhq-q7q7)
- [Pocket-TTS:n korjaustilan seuranta](https://security-tracker.debian.org/tracker/CVE-2026-116096)

Ylläpitäjän nykyinen SECURITY.md ilmoittaa yksityisen tietoturvailmoitusohjelman
olevan keskeytetty ja rajaa muun muassa kokeellisia toimintoja käsittelyn
ulkopuolelle. Tämä huomioidaan ylläpidon arvioinnissa.
[Turvallisuusohje](https://github.com/ggml-org/llama.cpp/blob/master/SECURITY.md)

Suositus säilyy rajattuna: llama.cpp on moottoriehdokas omaan eristettyyn
prosessiin. node-llama-cpp käyttää samaa moottoria sidoksen kautta, joten
sidoksen vaihtaminen ei yksin poista sen lataus- ja laskentavirheitä.
Ollaman tai ONNX-runtimen turvallisuusparemmuutta ei ole tässä todistettu.
[Sidoksen kuvaus](https://github.com/withcatai/node-llama-cpp/blob/master/package.json)

Toteutusversion valinnassa tarkistetaan sen tarkka build/commit, käytettävä
GPU-tausta ja malliformaatti. Sallitaan vain tarvittava paikallinen viestintä,
hyväksytyt mallitiedostot ja rajatut resurssit. Mallimoottori ei saa
henkilökohtaisia tiedostoja, shelliä tai ulkoista verkkoyhteyttä.
Loopback ja apuprosessi eivät yksin toteuta näitä oikeusrajoja.
Rajat todennetaan ennen verkollista käyttöä perusarkkitehtuurin mukaan.

## Painot, konteksti ja tiedon käyttö

Painot ovat koulutuksessa opittuja numeerisia parametreja, jotka toimitetaan
mallitiedostossa. GGUF on moottorin käyttämä tiedostomuoto. Kvantisointi
vähentää painojen esitystarkkuutta sekä muistitarvetta; vaikutus laatuun
mitataan. Esimerkiksi Q4_K_M on kokeiltava vaihtoehto, ei lupaus siitä että
koko ajo mahtuu näytönohjaimen muistiin. Myös konteksti ja ajon työmuisti
vaikuttavat muistitarpeeseen.

Poro 2 8B:n mallikortti ilmoittaa noin kahdeksan miljardia parametria.
Painoja ei säädetä yksitellen käyttöliittymän säätimillä. Ajossa muutetaan
esimerkiksi rooliohjetta, kontekstia, vastauspituutta ja näytteenottoasetuksia.
Painojen muuttaminen tarkoittaisi koulutusta tai hienosäätöä, joka on erillinen
myöhempi koe.

Sovelluksen rooliohje, mallin painot ja keskustelun konteksti ovat eri asioita.
Sään tai laskettujen kohdetietojen antaminen kontekstissa ei kouluta painoja
uudelleen. Alkuun kokeillaan valmista Instruct-mallia, rajattuja ohjeita ja
validoitua aineistoa. Hienosäätöä tai vektoritietokantaa ei tarvita lähtöehdoksi.

Käyttäjän toivoma vapaa tähtitiedekeskustelu on mukana mallikokeessa.
Illan ajantasaiset väitteet perustuvat laskentaan ja ennusteeseen.
Yleistiedon kohdalla arvioidaan selitysten oikeellisuus sekä kyky ilmaista
epävarmuus. Tarvittaessa myöhemmin rajattu paikallinen tietoaineisto voidaan
liittää mallin kontekstiin.

## Mallikoko ja muistin arviointi

Ehdokkaat ja tiedostokoot ovat yllä vertailutaulukossa. Kvantisoinnin
perusteet ja ajomuistin osat omistaa
[kvantisointikuvaus](#kvantisointi-ja-vertailun-koko).
Suurempi malli ei automaattisesti voita pienempää. Osa painoista voidaan
ajaa CPU:lla ja osa GPU:lla; viive mitataan valitulla kontekstilla.
Myös GPU:lla suoritettava ajo käyttää keskusmuistia.

Koneen resurssit on aiemmin tarkistettu, mutta malleja ei ole ajettu.
Konekohtainen inventaario säilyy keskustelussa, ei jaettavissa ohjeissa.
EKYn mallivalinta vaatii sen omat tehtävät ja kohdekoneet:
Tähtiapurissa pärjäävä 4B on ehdokas, ei EKYn hyväksytty tuotantomalli.

## Roolikokeen tarkoitus

Roolien, ohjelmakoodin koordinaattorin ja työkalujen vastuut omistaa
[avustajan työnkulkusuunnitelma](assistant-orchestration-plan.md).
Ensimmäisen yhden opastajaroolin lähtötasoa verrataan myöhemmin
suunnittelijan ja opastajan työnkulkuun samalla ladatulla mallilla.

Kokeessa mitataan faktavirheet, työkalujen onnistuminen, viive ja tokenikulutus.
Sama malli eri ohjeilla ei saa automaattisesti uutta asiantuntijatietoa.
Toinen mallirooli ei korvaa ohjelmakoodin tarkistuksia.
Arviointiaineistojen ja tulosten raportoinnin omistaa [testausohje](../ai/testing-rules.md).

## Mallin valinnan perusteet

Valinta perustuu samaan pieneen arviointijoukkoon: suomen kieli, annetussa
aineistossa pysyminen, epävarmuuden kertominen, vastaussopimus, työkalurajat,
viive ja muistinkulutus. Ajolaitteella mitataan myös kontekstin vaikutus,
ensimmäinen lataus, CPU-varatila ja mallin vapautuminen.

Ensimmäinen rooli on opastaja. Usean roolin hyöty tutkitaan vasta toimivan
lähtötason jälkeen. Usea agentti ei edellytä useita eri malleja.
Malliversio, kvantisointi, chat-template, tehtäväohje ja moottoriversio
sidotaan tulokseen; pelkkä mallin nimi ei tee vertailusta toistettavaa.

## Mallimoottorin ja painojen toimitus

Tähtiapuri on paikallinen vertailulaboratorio. Ohjelma, valittu moottori,
tarvittavat DLL:t ja mahdollinen eristyskäynnistäjä voidaan toimittaa
samassa asennuksessa. Vertailumallien GGUF-painot säilyvät
[erillisessä paikallisessa kansiossa](#paikallinen-mallikansio).
Ollama, Python tai virtuaalikone eivät ole loppukäyttäjän asennusvaatimuksia.
Ohjelman tai asentimen kokoon ei anneta arviota ennen todellista buildia.

Ensimmäinen toimituskoe varmistaa, että paketoitu desktop käynnistää
valitun moottorin ja käyttää hyväksyttyä ulkoista mallia offline.
Koko mallikirjastoa ei kopioida buildiin. Mallin puuttuminen, siirtäminen
ja poistaminen testataan. Yhden pienen mallin paketoiminen mukaan voidaan
myöhemmin arvioida erillisenä EKYyn siirrettävänä kokeena; se ei ole
Tähtiapurin ensimmäisen toimituskokeen vaatimus eikä EKYn toteutuspäätös.

Natiivimoottori ja tarvittavat kirjastot ovat todellisia resurssitiedostoja
ASAR-arkiston ulkopuolella. CPU-ominaisuudet, runtime-kirjastot ja GPU-ajurit
varmennetaan toimituskokeessa. GPU-ajuria ei oleteta asentimen mukana.
Käyttäjäkohtaisen eristyksen ja jokaisen käynnistyksen oikeusprofiilin omistaa
[turvallisuussuunnitelma](security-and-permissions-plan.md#suositus-samaan-asennuspakettiin).

Tarkat moottori- ja malliversiot, formaatit, kvantisoinnit, alkuperä,
tarkisteet ja lisenssit kirjataan kokeeseen. Tarkiste osoittaa tiedoston
vastaavuuden, ei julkaisijan luotettavuutta. Painot ja konekohtaiset polut
eivät kuulu Gitiin, tavalliseen sovellusbuildiin tai käyttäjätietojen vientiin.
Mallien erillinen hankinta ei poista käyttöehtojen noudattamista;
mahdollinen edelleenjakelu käsitellään erikseen.

Asentimen kokorajat riippuvat valitusta kohteesta ja työkaluketjusta.
Electron-builder tarjoaa esimerkiksi erillisen nsis-web-kohteen suurille
latauksille. Sitä ei oteta Tähtiapuriin: käyttöruntimelle ei lisätä
mallien latauspalvelua, eikä kaikkia Windows-asentimia koskevaa
2–4 GB:n rajaa tai tiettyä buildiaikaa oleteta.
[Electron-builderin kohdevertailu](https://www.electron.build/docs/targets/)

## Kehitys- ja diagnostiikkarajapinta paikalliseen malliin

Käyttäjän vahvistama vaatimus: Codex voi kehityksessä tai tarvittaessa
lähettää paikalliselle mallille koepyyntöjä ja lukea vastaukset ohjelman
sisäisen rajapinnan kautta. Kyse on kehitystyökalusta, ei tähtiharrastajan
käyttötapauksesta. Rajapintaa tai Codexin yhteysasetuksia ei ole toteutettu.

### MCP:n käyttötarkoitus kehityksessä

Codex toimii kehittäjänä ja arviointikokeiden käyttäjänä. Rajapinta auttaa
lähettämään rajattuja koepyyntöjä saman mallisovittimen läpi, toistamaan
tapaukset eri malleilla ja tarkistamaan tulosmuodon, virheet sekä peruutuksen.
Koetapauksessa käytetään tunnettuja sää- ja tähtilaskentatietoja;
Codexin oma arvio ei korvaa riippumatonta laskentavertailua tai testejä.

Keskustelu tai MCP-kutsu ei itsessään kouluta mallin painoja. Kehityksessä
voidaan parantaa rooliohjeita, annettua kontekstia, vastaussopimuksia ja
sovelluksen tarkistuksia. Varsinainen painojen hienosäätö vaatisi erillisen
koulutusaineiston, koulutusajon ja arvioinnin; sitä ei ole päätetty mukaan.

Tähtiapuri toimii tavallisessa käytössä ilman Codexia. MCP ei ole ainoa
mallikokeiden ajotapa: paikallinen testiajuri voi käyttää samaa sovitinta.
MCP:n lisähyöty on kokeiden käyttö Codexin työkaluna ja integraation oppiminen.

[OpenAI Docs: MCP](https://learn.chatgpt.com/docs/extend/mcp) dokumentoi
Codexin paikallisen stdio-tuen (tarkistettu 3.11.2026). Se ei tarkoita,
että Tähtiapurin palvelin olisi jo tehty tai yhteys käytettävissä.
Käyttäjä pyysi perustelemaan yhteyden tarkoituksen ennen aineistorajan
valintaa. Käyttäjätietojen hakua tai valittujen näytteiden välitystä ei
tällä perusteella lisätä; [aineiston laajuus](#aineisto-ja-luottamusraja)
on edelleen avoinna ja synteettinen koeaineisto säilyy lähtökohtana.

### Ehdotettu yhteystapa

Käyttäjä valitsi kehitysyhteyden suunnaksi paikallisen stdio-MCP:n jo
ensimmäiseen mallikokeeseen. Erillistä omaa komentoprotokollaa ei rakenneta
ennen sitä. MCP-sovitin pysyy ohuena: se välittää nimetyt mallikokeet
backendin kehitysporttiin, joka käyttää samaa mallijonoa ja sovitinta kuin UI.

[OpenAI Docs: MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
kuvaa paikallisen stdio-prosessin tuen sekä työkalujen sallittujen listan
(tarkistettu 2.11.2026). Kehitysyhteys otetaan erikseen käyttöön
kyseisellä Codex-isännällä. Tavallinen selainkeskustelu ei saa tämän
suunnitelman perusteella pääsyä koneen malliin.

Suunniteltu polku on Codex MCP-asiakkaana → paikallinen stdio-MCP-sovitin →
backendin rajattu kehitysportti → yhteinen mallijono ja mallisovitin →
paikallinen moottori. Sovitin erotetaan rendererin sovellusrajapinnasta.
Stdio-yhteydelle ei avata HTTP-palvelinta, julkista porttia tai etätunnelia.

MCP-sovittimen ja käynnissä olevan backendin väliin arvioidaan
käyttöoikeuksilla rajattua paikallista IPC-yhteyttä. Sen tarkka kuljetus,
todentaminen ja Windows/WSL-yhteensopivuus selvitetään kokeella.
MCP-suunnan valinta ei vielä hyväksy SDK:ta, sen versiota tai asennusta.

MCP-protokolla ei ole käyttöjärjestelmän hiekkalaatikko.
[MCP:n paikallisten palvelinten turvallisuusohje](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices#local-mcp-server-compromise)
suosittelee stdiota ja prosessin oikeuksien rajaamista.
Sovitin käynnistetään tunnetusta paikallisesta versiosta ilman mielivaltaista
komentojen välitystä. Sille välitetään vain tarpeelliset ympäristöarvot;
GitHub-tunnuksia, Codexin muita yhteystietoja tai käyttäjän yleisiä
hakemisto-oikeuksia ei tarvita. Käynnistettävä ohjelma, versio, argumentit,
työhakemisto ja ympäristö sidotaan tunnettuun kokoonpanoon; pakettia ei
haeta verkosta käynnistyksen sivuvaikutuksena. Sovittimen käyttöjärjestelmäraja
valitaan ja todennetaan erikseen. Codexin komentojen hiekkalaatikko ei
automaattisesti rajaa MCP-palvelimen prosessia
([OpenAI Docs: oikeuksien soveltamisala](https://learn.chatgpt.com/docs/permissions#scope-and-enforcement)).

### Kehityksen GitHub-yhteys on eri vastuu

Codexin GitHub-yhteys palvelee kehitystyön tehtäviä ja versionhallintaa.
Se ei kuulu paikallisen mallin työkaluihin tai Tähtiapurin MCP-palvelimeen.
Paikallinen malli ei saa GitHub-tunnuksia, repositoryoikeuksia tai reittiä
Codexin muiden työkalujen kutsumiseen. MCP-vastaus ei valtuuta GitHub-muutosta.
GitHubin käytön työnjaon omistaa
[yhteisen kehitystavan suunnitelma](../ai/project-start-checklist.md#tehtävien-ohjeiden-ja-tarkistusten-työnjako).

### Rajattavat operaatiot ja oikeudet

Ensimmäiseen sopimukseen ehdotetaan kolmea nimettyä operaatiota:

- Mallin toimintatila ja version tunnisteet ilman käyttäjäaineistoa.
- Rajattu koepyyntö, jonka aineisto annetaan nimenomaisesti kyseiseen kokeeseen.
- Oman koepyynnön peruutus.

### Kehitysyhteyden kytkin

Sovittu suunnitteluun 3.11.2026: asetusten Kehitystyökalut-osassa on
Salli Codex/MCP-kehitysyhteys -kytkin ja näkyvä yhteyden tila.
Yhteys on pois joka sovelluskäynnistyksessä. Päälle kytkeminen sallii vain
käynnissä olevan sovelluksen rajatun kehitysistunnon; Codexin ensimmäinen
MCP-liitäntä tehdään erikseen kehityskäyttöönotossa.

Stdio-MCP välittää viestit prosessin stdin/stdout-kanavissa eikä itsessään
avaa TCP-verkkopalvelinta
([MCP:n kuljetuskuvaus](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio)).
Suljettava kehitysportti tarkoittaa tässä backendin rajattua paikallista
IPC-yhteyttä, ei uutta verkkopalvelimen porttia. Tarkka IPC-väline on avoinna.

Pois kytkeminen toimii backendin valvomana katkaisuna:

1. Uudet kehityskutsut estetään ja nykyiset oikeustodisteet mitätöidään.
2. Jonossa ja ajossa olevat MCP-työt perutaan; sulkemisen jälkeen niiden
   myöhäisiä tuloksia ei enää välitetä. Käyttöliittymän mallityöt jatkavat.
3. Kehitys-IPC:n kuuntelu ja avoimet kehitysyhteydet suljetaan.
   Uusi avaus tarvitsee uuden oikeuden; vanha yhteys ei palaudu itsestään.

Codex omistaa stdio-sovittimen prosessin. Sovittimen jääminen käyntiin ei
säilytä käyttöoikeutta: sovelluksen ollessa pois tai kehitysyhteyden suljettuna
se palauttaa saatavuusvirheen eikä käynnistä sovellusta. Sovelluksen sulkeminen
ja uudelleenkäynnistys mitätöivät kehitysistunnon
[prosessien sopimuksen](base-architecture.md#prosessit-ja-kulkureitti) mukaisesti.

Myös Codexissa palvelimen voi poistaa käytöstä enabled-asetuksella
([OpenAI Docs: MCP](https://learn.chatgpt.com/docs/extend/mcp)).
Asiakkaan pois-asetus ei korvaa Tähtiapurin backendin katkaisua eikä
Tähtiapuri muuta Codexin yhteysasetuksia. Asiakasasetuksen voimaantulo
varmennetaan käytetyssä Codex-versiossa. Molempien puolten on sallittava
yhteys, jotta mallikoe onnistuu. Avustaja ja MCP eivät saa muuttaa kytkintä.

Yhteys tarkistaa sallitun asiakkaan, operaation, aineiston koon ja
istunnon käyttöoikeuden. Pyyntöjen määrä, konteksti, tulostus ja kokonaisaika
rajataan samassa resurssijonossa kuin sovelluksen mallitehtävät.
Paikallinen IPC tai loopback ei yksin todista kutsujan oikeutta.
Codexin työkalujen sallittujen lista täydentää palvelimen omaa validointia;
MCP:n työkalukuvaukset tai annotaatiot eivät korvaa oikeustarkistusta.
MCP:n kuljetussuunta on stdio ja aktivointi tapahtuu asetuskytkimestä.
Backendin IPC-kuljetus, todentaminen ja käyttöjärjestelmän rajat ovat avoinna.

Suora mallikoe ei suorita mallin ehdottamia työkaluja, sääpäivityksiä tai
käyttöliittymämuutoksia. Mahdollinen myöhempi käyttötapauskoe kulkee
[avustajan koordinaattorin ja samojen tarkistusten](assistant-orchestration-plan.md)
kautta kuin sovellus. Kehitysrajapinta ei tarjoa vapaata URL-hakua, tiedostopolkua,
shell-komentoa, moottoriasetusten muuttamista tai yleistä sovelluksen hallintaa.

### Aineisto ja luottamusraja

UI ja MCP jakavat moottorin sekä resurssijonon, eivät keskustelukontekstia.
Backend sitoo jokaisen työn varmennettuun kutsujaryhmään ja pyyntöön.
MCP-kokeelle rakennetaan oma konteksti; käyttöliittymän historiaa,
keskeneräistä vastausta tai aiemman ajon KV-välimuistia ei siirretä siihen
vahingossa. Istuntojen erottelu ja moottorin välimuistin käsittely
todennetaan valitulla sovittimella. Peruutus koskee vain kutsujan omaa työtä.

Kokeissa käytetään oletuksena synteettistä aineistoa. Käyttäjän sijainteja,
keskusteluhistoriaa tai muuta yksityistä aineistoa ei liitetä pyyntöön
automaattisesti. Salaisuuksia ei palauteta tuloksissa tai tallenneta
koepyyntöjen lokeihin. Paikalliselle mallille ei anneta repositoryn
muokkaus- tai shell-oikeutta.

Codexille palautettu sisältö tulee myös Codexin käsiteltäväksi. Koko
vaihtoa ei kuvata täysin paikalliseksi, vaikka malli itsessään pysyy
ilman verkkoyhteyttä. Mallin vastaus on epäluotettua koetulosta;
siinä olevat toimintaohjeet eivät oikeuta Codexia muuttamaan tiedostoja
tai suorittamaan komentoja. Kanava lisää hyökkäyspintaa, joten sen rajaus
todennetaan erikseen [testausohjeen](../ai/testing-rules.md) mukaisesti.

## Tarkistetut taustalähteet

- [llama.cpp-palvelimen virallinen dokumentaatio](https://github.com/ggml-org/llama.cpp/tree/master/tools/server)
- [Electronin ASAR-rajoitukset](https://www.electronjs.org/docs/latest/tutorial/asar-archives)

Nämä ovat arvioinnin lähtökohtia, eivät hyväksyttyjä riippuvuuksia.
