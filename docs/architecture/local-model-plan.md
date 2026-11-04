# Paikallisen mallin kokeilu ja toimitus

Tämä dokumentti kuvaa mallirajapinnan ja toimituksen suunnitelman.
Ensimmäisen kokeen 4B/8B-paketit ja työkaluketju on lukittu
[kokeen lähtötietoihin](../experiments/model-pilot.md). T03:ssa Qwen3-4B on
ajettu erillisessä UtilityProcessissa sekä CPU:lla että CUDA:lla;
[toteutuneen moottorikokeen raportti](../experiments/model-runtime-probe.md)
omistaa näytön ja toimituksen avoimet ehdot.
[Päätösten tila](../planning/decisions.md) omistaa valintojen hyväksynnän,
[turvallisuussuunnitelma](security-and-permissions-plan.md) yleiset oikeusrajat ja
[testausohje](../ai/testing-rules.md) arviointiaineistot ja tulosten raportoinnin.

## Suositus: vakaa rajapinta ensin, mallivalinta kokeilemalla

Oma mallirajapinta erottaa backendin käyttötapauksen natiivimoottorista.
T03:n toteutus käyttää oikeaa paikallista moottoria saman portin takana;
virhefixturet ovat vain testipuussa. Käyttäjä vahvisti 4B- ja 8B-mallien
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

Ensimmäisen kokeen täsmäversiot on lukittu
[kokeen lähtötietoihin](../experiments/model-pilot.md). T03:n 4B-ajo todensi
node-llama-cpp 3.22.2:n UtilityProcess-yhteensopivuuden paikallisessa
Windows-kehityskokoonpanossa. T04:n erillinen [4B/8B-laatuvertailu](../experiments/model-comparison.md)
on tehty; paketoitu ajo on vielä kokeilematta.
T09c:n erillinen [SDK-eristyskoe](../experiments/sdk-isolation-probe.md)
käyttää CPU-binääriä ilman mallipainoja. Julkinen CPU-alustus, SDK:n sisäinen
binäärikoelapsi ja mallin lataus/generointi ovat erillisiä hyväksymisnäyttöjä.
Korjatun erillisen Noden [CPU-/helper-vertailu](../experiments/runtime-comparison.md#mitattu-node-sdk-vertailu)
on läpäissyt. Tämä ei vaihda sovelluksen nykyistä UtilityProcess-toteutusta
eikä hyväksy sen OS-eristystä tai paketointia.
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
Käyttäjä hyväksyi rajatun Windows-kehityskokeen ennen OS-eristyskoetta.
Sen oikeudet, projektikohtaiset asennuspolut ja toistettavat syötteet
omistaa [kokeen lähtötieto](../experiments/model-pilot.md).
Sovellusrungon ja oikean 4B-mallin ajon näyttö on tehty T02/T03:ssa.
T04:n [4B/8B-laatuvertailu](../experiments/model-comparison.md) on tehty
erillisessä testiajurissa. T05:n kehitys-MCP käyttää samaa jonoa ja mallirajaa erillisen omistajuuden kautta.

## T03:n toteutettu malliraja

Kulkureitti on UI → rajattu preload → main → backendin assistant-jono →
mainin ModelHost → erillinen mallityöntekijä. Main omistaa molemmat
UtilityProcessit; vain mallityöntekijä importoi natiivisovittimen.
Backendin application-kerros riippuu omasta ModelEngine-portista.

- Julkiset kutsut ovat assistant.submit/get/cancel. Syöte sisältää vain
  1–2000 merkin kysymyksen ja eksplisiittisen cpu/cuda-valinnan; ei
  tiedostopolkua, URLia, malliparametreja tai ohjelmakomentoa.
- Backendissä on enintään yksi aktiivinen ja yksi odottava työ sekä
  kuusi muistissa säilyvää työnäkymää. Työtunniste on backendin UUID.
- Main–mallityöntekijä käyttää omaa 256-bittistä istuntoa, tiukkoja
  viestimuotoja ja yhtä aktiivista työtä. Hyväksytty GGUF-profiili ja
  työkalupolut tulevat mainin tunnetusta kokoonpanosta.
- Mallin latausraja on 120 s, generoinnin 60 s. Peruutus käyttää ensin
  SDK:n AbortSignalia ja tarvittaessa pysäyttää työntekijän 5 s jälkeen.
  Backendin 185 s ulkoraja kattaa myös alustuksen ja siivouksen.
- loading kattaa tarkistuksen, latauksen ja valmistelun; running alkaa
  ensimmäisestä SDK:n tekstikatkelmasta. UI saa lopuksi rajatun vastauksen,
  virhekoodin ja todellisen ajotaustan/GPU-kerrokset; raakaa natiivivirhettä
  tai paikallisia polkuja ei palauteta.
- Perutun työn myöhäinen tulos ei muuta tilaa. Aikakatkaisussa tai
  pakotetussa peruutuksessa vanha työntekijä poistuu ennen uuden työn ajoa.
- Jokaisella työllä on uusi konteksti. Malli ei suorita työkaluja;
  nykyinen vastaus renderöidään tekstinä. Historia ja karttatoiminnot
  lisätään omissa työpaketeissaan.

Tämä on yhden hyväksytyn 4B-profiilin kehitysrunko, ei vielä asetuksista
vaihdettava yleinen mallikirjasto. CPU-/CUDA-valinta ja työn peruutus
toimivat jo UI:ssa. Tarkat natiiviyhteensopivuuden havainnot ja avoin
RunAsNode-fuse-ehto ovat [moottorikokeessa](../experiments/model-runtime-probe.md).

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
Ensimmäiset Qwen3-4B/8B Q4_K_M -paketit ja moottorin npm-versio ovat
[lukittuina kokeeseen](../experiments/model-pilot.md). Toteutuneen 4B-ajon
kokoonpano on [moottorikokeen raportissa](../experiments/model-runtime-probe.md).
8B on ladattu ja ajettu T04:n erillisessä laatuvertailussa;
14B:n ja muiden perheiden paketit ovat avoimia.

| Ehdokas | Tila ja kokeen tarkoitus | Avoin osa |
| --- | --- | --- |
| LumiOpen Llama-Poro-2-8B-Instruct | Sovittu: suomenkielinen keskustelu ja työkalutehtävät mitattavina. | GGUF-alkuperä, tarkka kvantisointi, chat-template, käyttöehdot ja oma arviointi. |
| Ministral 3 8B Instruct 2512 | Sovittu: eurooppalainen keskustelu- ja työkalumallin verrokki. | Tarkka GGUF ja kvantisointi; suomen kieli, faktat ja työkalut mitataan. |
| Qwen3-4B Q4_K_M | T03:n oikea CPU-/CUDA-vastaus ja elinkaarikokeet läpäisty. | T04:n vertailu tehty; puutteet ja jatkokoe [vertailuraportissa](../experiments/model-comparison.md). |
| Qwen3-8B Q4_K_M | T04:n toistettu CPU-/CUDA-laatuvertailu tehty. | Ohjeiden laadun kehityskoe; havaintokäytön mallia ei vielä hyväksytty. |
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
henkilökohtaisen käytön ja voi sallia myös yrityskäytön
ehtoja noudattaen. Kaupallisuus ei yksin sulje mallia pois. Tarkistetaan
valitun mallipaketin ehdot ja hyväksyttävän käytön säännöt; jakelussa
säilytetään vaaditut lisenssi- ja tekijämerkinnät sekä Built with Llama
-merkintä. Mallivalinta ja käyttöönotto arvioidaan aina erikseen.
[Alkuperäinen lisenssi](https://github.com/meta-llama/llama-models/blob/main/models/llama3_3/LICENSE)

Poron tekijöiden raportoimat suomenkieliset testit tukevat mallin ottamista
vertailuun. Ne eivät ole oma mittauksemme tai suora vertailu nykyiseen
Ministraliin. Suomen luontevuus, tähtitiedon oikeellisuus ja työkalupyynnöt
arvioidaan samassa omassa tehtäväjoukossa.

## Mahdolliset lisäehdokkaat ja kevyempi kohdekone

Vähämuistisempien kohdelaitteiden myöhempään arviointiin säilyvät alla olevat
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

Yksittäinen kehityskoe ei määrää yleistä oletusmallia.
Vähämuistiselle kohdekoneelle arvioidaan erikseen pieni kvantisoitu malli,
CPU-ajo, lyhyt rajattu konteksti ja yksi tehtävä kerrallaan. Kokonaismuistiin
kuuluvat myös käyttöjärjestelmä, Electron, backend ja muu sovelluskuorma.
Näytönohjaimen olemassaoloa, sen muistia tai sujuvaa ajoa ei oleteta.
Tämä on suunnitteluperiaate, ei todennettu hyväksyntä tietylle kohdelaitteelle.

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

Koneen resurssit on tarkistettu ja 4B:n CPU-/CUDA-toimivuus todettu.
Laajempi viive- ja muistivertailu on vielä tekemättä. Asennettujen
binääriehdokkaiden tarkisteet säilyvät paikallisessa koe-artefaktissa;
[moottorikokeen raportti](../experiments/model-runtime-probe.md) kokoaa jaettavan näytön.
Mallivalinta vaatii käyttötapaus- ja kohdelaitetestit:
pilotissa pärjäävä 4B on ehdokas, ei hyväksytty tuotantomalli.

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
myöhemmin arvioida erillisenä toimituskokeena; se ei ole
Tähtiapurin ensimmäisen toimituskokeen vaatimus.

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

T05 toteuttaa rajatun stdio-MCP-sovittimen `apps/mcp/`-sovelluksessa.
Tämä osuus omistaa kehitysyhteyden teknisen sopimuksen;
[käyttöohje](../development/mcp.md) omistaa käynnistyksen ja Codex-isännän
erillisen määrityksen. Yhteys ei ole edellytys Tähtiapurin tavalliselle käytölle.

### MCP:n käyttötarkoitus kehityksessä

Codex voi lähettää itsenäisiä mallikokeita saman jonon ja mallisovittimen läpi
sekä tutkia tulosmuodon, virheet ja peruutuksen. Koetulos on epäluotettua
aineistoa. Se ei anna lupaa tiedostojen tai asetusten muuttamiseen.
Keskustelu tai koepyyntö ei kouluta mallin painoja; rooliohjeen ja syötteen
kehittäminen erotetaan mahdollisesta myöhemmästä hienosäädöstä.

### Ehdotettu yhteystapa

Valittu ja T05:ssa toteutettu polku on MCP-asiakas → stdio-sovitin →
mainin erillinen Windows named pipe → backendin kehitysmoduuli →
assistant-moduulin yhteinen jono → mainin ModelHost → natiivimoottori.
MCP SDK:n palvelin ja asiakas ovat versiota 2.4.0; Zod 4.6.7 validoi
työkalujen syötteet. Oma MCP-protokollatoteutus jätettiin vaihtoehdoksi.

Sovitin ei tarjoa HTTP-palvelinta, TCP-porttia tai tunnelia.
Main–backend-session oikeutta ei jaeta rendererille tai MCP-sovittimelle.
Kehitysistunto käyttää omaa 256-bittistä satunnaista capabilitya ja
jokainen todennettu yhteys omaa mainin luomaa asiakastunnistetta.
Roolia, oikeutta tai tiedostopolkua ei voi antaa MCP-työkalun argumenttina.

Main julkaisee capabilityn vain oman datajuuren `mcp/connection.json`-tiedostoon.
Windowsin kiinteä PowerShell/.NET-apuri luo erillisen hakemiston suojatulla
DACL:llä vain nykyiselle käyttäjälle ja SYSTEMille. Omistaja, suojattu DACL,
molemmat SID:t, FullControl- ja periytymisflagit sekä reparse-esto tarkistetaan
ennen `wx`-kirjoitusta. Olemassa olevaa liian avointa hakemistoa ei hyväksytä.
Pelkkää Windowsin `0600`-tiedostomoodia ei pidetä suojauksena.

Tämä ei eristä saman Windows-käyttäjän haitallista ohjelmaa. Node named pipen
oletus-DACL:ää tai etäasiakkaiden OS-torjuntaa ei kuvata todennetuksi
verkkorajaksi: sovellus tarkistaa capabilityn ennen mitään vastausaineistoa.
Koko sovelluksen OS-eristyksen omistaa
[turvallisuussuunnitelma](security-and-permissions-plan.md).

### Kehityksen GitHub-yhteys on eri vastuu

Codexin kehitystyön GitHub-yhteys ei kuulu paikallisen mallin työkaluihin.
Sovitin ei välitä GitHub-tunnuksia tai reittiä Codexin muihin työkaluihin.
Mallin vastaus ei valtuuta GitHub-muutosta.

### Rajattavat operaatiot ja oikeudet

- `model_status({ jobId? })`: kehitysyhteyden tila ja hyväksytyn profiilin
  versiot; tunnisteella vain tämän yhteyden oman kokeen tila ja tulos.
  Tämä ei väitä mallin olevan ladattuna tai ilmoita koneinventaariota.
- `model_probe({ prompt, backend })`: itsenäinen, nimenomaisesti annettu
  enintään 2000 merkin koe. Vastaa työn tunnisteella; käyttää samaa
  yhden aktiivisen ja yhden odottavan työn jonoa kuin UI.
- `cancel_probe({ jobId })`: vain saman kehitysyhteyden oma koe.

Muita työkaluja, historia-, tiedosto-, sää-, shell- tai asetuskutsuja ei ole.
Tuntemattomat ja ylimääräiset kentät torjutaan sekä MCP- että backend-rajalla.
Backend sitoo työn omistajan varmennettuun yhteyteen. UI ei voi lukea tai
perua MCP-työtä, eikä MCP toisen yhteyden tai UI:n työtä.

Kuljetuksessa on enintään neljä avointa socketia, yksi todennettu asiakas
ja neljä odottavaa komentoa. Tunnistautuminen päättyy kolmessa sekunnissa;
kutsuja sallitaan enintään 60 sekunnissa. Pyyntökehyksen raja on 16 KiB,
vastauskehyksen 64 KiB ja erillisiä kehityskutsuja odotetaan enintään 5 s.
Takaisinpaineella odotetaan enintään 2 s eikä mainin ulostulopuskuri kasva
yli kahden vastauskehyksen. Aktiivisen kytkinsiirtymän lisäksi sallitaan
vain yksi yhdistetty sulkupyyntö. Mallin omat aikarajat säilyvät yllä
[T03:n mallirajassa](#t03n-toteutettu-malliraja).

### Kehitysyhteyden kytkin

Asetusten Kehitystyökalut-osan **Salli Codex/MCP-kehitysyhteys** on pois
jokaisella sovelluskäynnistyksellä. Kytkintä käyttää vain luotettu UI-kanava;
MCP tai paikallinen malli ei saa sitä muuttaa.

Pois kytkeminen estää mainissa uudet kutsut heti. Backend mitätöi
kehitysistunnon ja peruu sekä unohtaa sen työt ennen kanavan sulkemista.
Main sulkee socketit, kuuntelun ja oman yhteystiedoston. Kesken kirjoituksen
tullut sulku ei voi avata vanhaa istuntoa uudelleen. UI:n työt säilyvät.
Uusi avaus luo uuden capabilityn; vanha oikeus ei kelpaa.

Stdio-asiakkaan irtoaminen peruu ja unohtaa vain sen yhteyden omat työt.
Sovelluksen sulku katkaisee kehitysyhteyden ennen backendin ja mallin sulkua.
Codexin omistama stdio-prosessi voi jäädä odottamaan uusia protokollapyyntöjä,
mutta se palauttaa saatavuusvirheen eikä käynnistä sovellusta uudelleen.
Vanha sovitin ei liity automaattisesti uuteen istuntoon.

### Aineisto ja luottamusraja

UI ja MCP jakavat moottorin ja resurssijonon, eivät kontekstia.
Natiivisovitin luo ja hävittää kontekstin sekä chat-session jokaiselle työlle.
Historiaa, havaintopaikkoja, aiempia vastauksia tai KV-välimuistia ei lueta
MCP-kokeeseen. Kokeissa käytetään lähtökohtaisesti synteettistä aineistoa.
Tulosteita ei tulkita sovelluksen tai Codexin toimintakäskyiksi.

Codexille palautettu sisältö tulee myös Codexin käsiteltäväksi.
Todellinen stdio-asiakas ja natiivimoottorin kontekstierottelu testataan
[testausohjeen](../ai/testing-rules.md) mukaan. Tämä ei ole Codex-isännän
käyttöönoton, WSL-yhteensopivuuden tai OS-eristyksen todiste.

Lähteet: [MCP SDK:n stdio](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md),
[OpenAI Docs: MCP](https://learn.chatgpt.com/docs/extend/mcp),
[Windowsin suojatun hakemiston luonti](https://learn.microsoft.com/en-us/dotnet/api/system.io.directory.createdirectory?view=netframework-4.8.1#system-io-directory-createdirectory(system-string-system-security-accesscontrol-directorysecurity)).

## Tarkistetut taustalähteet

- [llama.cpp-palvelimen virallinen dokumentaatio](https://github.com/ggml-org/llama.cpp/tree/master/tools/server)
- [Electronin ASAR-rajoitukset](https://www.electronjs.org/docs/latest/tutorial/asar-archives)

Nämä ovat arvioinnin lähtökohtia, eivät hyväksyttyjä riippuvuuksia.
