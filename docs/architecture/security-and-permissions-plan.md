# Turvallisuus ja osien oikeudet

Tila: kohdan 6 sovitut päälinjat ja toteutusehdotukset, 3.11.2026.
Sovittu päälinja on erillinen käyttöjärjestelmätasolla rajattu malliprosessi.
Ohjelma ja moottori suunnitellaan samaan asennukseen; Tähtiapurin
vertailupainot ovat erillisessä paikallisessa mallikansiossa.
Vain säätyöntekijän ulkoinen verkkolupa on tavoite. Muut alla esitetyt
oikeustarkennukset ja toteutusmekanismit ovat ehdotuksia, ellei niitä merkitä
sovituiksi. T02:n statusrunko ja sen IPC-rajat on toteutettu;
Sovelluksen OS-eristystä ei ole vielä toteutettu.
Erillinen [natiivikoe](../experiments/windows-isolation-probe.md)
rajaa T09a:n synteettisen koepaketin ja sen näyttöportit.
[SDK-koe](../experiments/sdk-isolation-probe.md) erottaa julkisen CPU-alustuksen
SDK:n sisäisestä lapsikokeesta; kumpikaan ei yksin hyväksy sovelluksen OS-rajoja.
T05:n rajattu stdio-MCP-yhteys
käyttää Windowsin capability-todennettua named pipe -sovitinta;
[mallisuunnitelma](local-model-plan.md#kehitys--ja-diagnostiikkarajapinta-paikalliseen-malliin)
omistaa toteutetun sopimuksen. Se ei ole koko sovelluksen OS-eristys.
T07:n nimetyt [karttakyselyt](sky-map.md#nimetty-ipc-ja-resurssit) käyttävät samaa
lähettäjä- ja istuntorajaa ilman uusia verkko- tai tiedosto-oikeuksia.
T08:n [havaintopaikat](observing-places.md) lisäävät vain nimetyt UI-asetustoiminnot
ja backendin kiinteän observing-tallennuspolun; malli ja MCP eivät saa niitä.
Päätösten tilan kokoaa [päätöshakemisto](../planning/decisions.md).

Tämä dokumentti omistaa oikeusmatriisin, alustarajauksen vaatimukset ja
turvallisen koodin periaatteet. [Perusarkkitehtuuri](base-architecture.md)
omistaa prosessien kulun ja sääkäyttötapauksen,
[mallisuunnitelma](local-model-plan.md#kehitys--ja-diagnostiikkarajapinta-paikalliseen-malliin)
MCP:n sopimuksen ja [tiedon elinkaari](data-lifecycle-plan.md) historian käytön.

## Rajauksen tarkoitus ja luottamus

Sää, mallivastaus, vanha keskustelu ja rendererin pyyntö ovat epäluotettua
syötettä. Niiden teksti ei saa valita uusia työkaluja, kutsujaroolia,
verkkokohteita tai oikeuksia. Malli ehdottaa; omistava käyttötapaus tarkistaa.

Suojaus koostuu kahdesta kerroksesta: sovelluksen nimetyt operaatiot ja
sisältötarkistukset sekä käyttöjärjestelmän valvomat prosessi-, tiedosto- ja
verkkorajat. IPC, CSP, prompti tai erillinen prosessi eivät korvaa jälkimmäistä.
Node.js kuvaa omaa Permission Modeliaan luotetun koodin virheitä rajaavaksi
mekanismiksi, ei haitallista koodia kestäväksi hiekkalaatikoksi
([Node.js:n ohje](https://nodejs.org/api/permissions.html)).

Ilmaisu vain säätyöntekijä nettiin koskee Tähtiapurin havaintokäyttöä.
Ohjelmien ja mallien hankinta sekä Codexin palvelu- ja GitHub-yhteydet ovat
erillisiä kehitys- ja ylläpitokanavia. Ne eivät kuulu ajonaikaiselle mallille.
MCP-koetuloksen palauttaminen Codexille on erikseen avattava tiedon kulkureitti;
koko kehitysistuntoa ei väitetä täysin paikalliseksi.

## Ehdotettu oikeusmatriisi

| Osa | Sallittu vastuu ja aineisto | Ulkoinen verkko |
| --- | --- | --- |
| Renderer ja preload | Näyttödata sekä nimetyt sovelluspyynnöt. Ei raakaa IPC-, Node-, levy-, prosessi- tai mallimoottori-APIa rendererille. | Ei. Myös ulkoiset kuvat, fontit, navigointi ja sivun käynnistämät yhteydet estetään. |
| Electron main | Ikkunat, lähettäjän tarkistus, kanavat ja omien prosessien elinkaari. Vain nimetyt käynnistykset ja paketin resurssit; ei liiketoimintaa tai vapaata komentovälitystä. | Ei. |
| Backend | Validoidut käyttötapaukset, laskenta, mallijono ja sovelluksen oma datajuuri. Antaa mallille rajatun kontekstin ja säätyöntekijälle vain kyselytiedot. | Ei. Pyytää ennusteen sääportin kautta. |
| Mallimoottori ja malliroolit | Hyväksytyt mallipainot luettavina, rajattu työtila sekä kyseiseen pyyntöön annettu konteksti. Ei suoraa käyttäjätietokantaa, kotihakemistoa, shelliä tai työkaluvaltuuksia. | Ei. Vain välttämätön, rajattu paikallinen mallikanava. |
| Säätyöntekijä | Yksi rajattu FMI-ennustekysely ja pieni tilapäinen työtila. Ei keskusteluja, tietokantaa, yleistä käyttäjäprofiilia tai kehitystunnuksia. | Kyllä, vain sovittu sääyhteys ja sen välttämätön nimenselvitys. Ei yleistä URL-välitystä. |
| Kehityksen stdio-MCP-sovitin | Tila, nimenomaisesti annettu mallikoe ja oman kokeen peruutus. Vain rajattu kehitys-IPC ja protokollan edellyttämä aineisto; ei käyttäjän datakansion lukuoikeutta. | Ei omaa verkkokäyttöä. Tulos kulkee stdiolla Codexille. |

Samat mallit voivat toimia eri rooleissa, mutta roolin nimi promptissa ei
luo käyttöjärjestelmäoikeutta. Oikeus muodostetaan varmennetun kanavan ja
käynnistys-/istuntokontekstin perusteella; asiakkaan lähettämä roolikenttä ei
riitä. Tarpeettomat kahvat, ympäristöarvot ja salaisuudet eivät periydy lapsille.
Uutta työtä ei oteta vastaan vanhalla käynnistyksellä tai suljetulla yhteydellä.

### Avustajan käynnistämät pysyvät muutokset

Sovittu 3.11.2026: tallennettujen havaintopaikkojen lisääminen, muokkaus ja
poistaminen, asetusten muuttaminen sekä historian poistaminen tehdään vain
ohjelman omista valikoista ja painikkeista. Niitä ei lisätä avustajan tai
MCP-kehitysyhteyden työkaluihin. Mallin ehdotus tai keskustelussa annettu
vahvistus ei avaa näitä toimintoja.

Backend tarkistaa hyväksytyn käyttöliittymäpolun luotetusta kanava- ja
käyttötapauskontekstista; mallin lähettämä lähdekenttä ei kelpaa todisteeksi.
Omistavat moduulit validoivat muutoksen. Malli ei saa suoraa tiedosto- tai
tietokantakirjoitusta. Tämä ei muuta sovittua keskustelujen tallennusta,
kartan ohjausta tai sääpäivityksen käynnistystapoja.

## Verkon ja tiedostojen todellinen eristys

Käyttäjä hyväksyi erillisen käyttöjärjestelmätasolla rajatun malliprosessin
ja yhteisen asentimen suunnittelupäälinjan 3.11.2026.
Windowsin AppContainer/LPAC on arvioitava toteutusmekanismi; sen tarkkaa
käyttöä, paikallista viestintää ja GPU-yhteensopivuutta ei ole valittu tai
todistettu. Modulaarinen toteutus ja yksi sovellusasennus säilyvät
tavoitteina. Kontti ja virtuaalikone säilyvät vertailu- ja mahdollisina
koeympäristöinä. Aiemmin arvioidut vaihtoehdot:

| Vaihtoehto | Hyöty tämän projektin kannalta | Selvitettävä ennen valintaa |
| --- | --- | --- |
| Windowsin oma eristys | Koe kohdistuu suoraan suunnitellun Electron-asennuksen oikeusrajoihin. | Eristysidentiteetit, käynnistys, paikallinen viestintä sekä GPU- ja paketointiyhteensopivuus. |
| Linux-kontit | Oikeusrajojen, resurssien ja toistettavan koeympäristön harjoittelu. | Konttiruntime ja sen Linux-ympäristö Windowsissa, GPU, rajattu viestintä ja jakelun lisäriippuvuus. |
| Erillinen Linux-virtuaalikone | Oma käyttöjärjestelmä ja hallittava koeympäristö; myös kontteja voidaan ajaa sen sisällä. | Muisti, levy, ylläpito, GPU ja Windows-sovelluksen rajattu yhteys vierasjärjestelmään. |

Windowsin oma eristys voi perustua esimerkiksi AppContaineriin sekä
sille sopiviin tiedosto- ja verkkosääntöihin. Microsoft kuvaa
AppContainerin erottelevan sovellusidentiteetin ja rajaavan tiedostoja,
prosesseja ja verkkoa
([Microsoftin kuvaus](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)).
Tämä ei ole vielä valittu tai testattu Electron-/llama.cpp-toteutus.

Pelkkä ohjelmapolkuun kohdistuva palomuurisääntö ei erottele samalla
electron.exe- tai Node-ohjelmalla ajettuja rooleja. Prosessien erottelulle
tarvitaan käyttöjärjestelmän tunnistama luotettava identiteetti tai muu
todennettu ratkaisu. Pelkkä erillisen suoritettavan tiedoston nimeäminen ei
rajaa sen tiedosto- tai lapsiprosessioikeuksia. Sovelluksen osat eivät saa
muuttaa omaa eristyspolitiikkaansa tai pyytää käynnistäjältä mielivaltaista
ohjelmaa tai laajempaa oikeusprofiilia.

Yleinen internet-capability ei myöskään ole FMI-kohteen sallittujen lista.
Tarkka kohderajaus edellyttää sovelluksen tarkistusten lisäksi siihen sopivaa
valvottua verkkovälitystä tai muuta erikseen todennettavaa ulospääsyrajausta.
DNS, IPv4/IPv6, välityspalvelimet ja paikalliset verkkopalvelut huomioidaan.
Säätyöntekijän nimenselvitysoikeus ei saa avata nimenselvitystä muille osille.
Nimetyn IPC:n ja mahdollisen paikallisen HTTP-mallikanavan poikkeukset
eivät saa antaa yleistä pääsyä koneen muihin palveluihin. Yksikään osa ei
avaa palvelua LAN-verkkoon tai yleiseen verkkoon.

Kunkin vaihtoehdon kokeessa selvitetään eristysidentiteetit, paikallinen
viestintä, mallin CPU/GPU-ajo sekä omistettujen prosessien sulkeutuminen.
Mahdollinen natiivi käynnistäjä on pieni luotettu osa, jonka ohjelmat ja
oikeusprofiilit ovat kiinteät. Sen tarvetta tai tekniikkaa ei päätetä tässä.
Virtuaalikone ja kontti tarvitsevat myös osien omat oikeudet ja verkkorajat.

Oikeuksia ei nosteta pääkäyttäjätasolle havaintokäytössä. Jos eristyksen
aktivointi tai sen näyttö puuttuu, sääverkkokoe ei käynnisty ja jatketaan
offline-aineistolla. Käyttöjärjestelmäasetuksia ei muuteta suunnittelun aikana.

### Malliprosessin ajotapa ja eristyksen vaiheistus

T03:ssa 3.11.2026 on testattu Qwen3-4B:n CPU-/CUDA-ajo erillisessä
UtilityProcessissa. [Moottorikokeen raportti](../experiments/model-runtime-probe.md)
erottaa tämän kehitysnäytön OS-eristyksestä. AppContainer-yhteensopivuutta
ja paketoitua kokoonpanoa ei ole testattu. Käyttäjä vahvisti mallikokeen
aloittamisen 4B:llä ja 8B:llä sekä alla kuvatun arviointisuunnan.
Käyttäjä hyväksyi 3.11.2026 rajatun Windows-kehityskokeen tavallisen käyttäjän
oikeuksilla ennen AppContainer/LPAC-koetta. Kokeen rajaus ja sallitut syötteet
ovat [lähtötiedoissa](../experiments/model-pilot.md). Tämä ei hyväksy
havaintokäytön verkko- ja tiedostorajaa.

Sovittu arviointisuunta on kokeilla node-llama-cpp:tä erillisessä
UtilityProcessissa ennen oman Windows-käynnistäjän laajaa toteutusta. Electronin kokeellinen
electron/llm näyttää tällaisen prosessijaon. Tämä ei valitse pakettia
riippuvuudeksi. T03 todentaa valitun node-llama-cpp:n CUDA-kehitysajon,
ei eristyksen tai paketoinnin toimivuutta.
llama-server erillisenä prosessina säilyy vaihtoehtona.
[Electronin vertailutoteutus](https://github.com/electron/llm)

Prosessiraja auttaa rajaamaan natiivikoodin kaatumisen malliajoon.
Tavallinen Node UtilityProcess ei silti toteuta sovittua verkko- tai
tiedostorajaa: luetun Electronin main-haaran NodeService on merkitty
kNoSandbox-tilaan, ja utilityProcess tukee verkkopyyntöjä.
Viestikanavan rajaus tai mallilta puuttuva verkkotyökalu ei poista
isäntäprosessin käyttöjärjestelmäoikeuksia.
[NodeService-lähde](https://github.com/electron/electron/blob/main/shell/services/node/public/mojom/node_service.mojom),
[UtilityProcess-ohje](https://www.electronjs.org/docs/latest/api/utility-process)

AppContainer/LPAC:n lisätyö ja CUDA-yhteensopivuus ovat todellisia
selvityskohteita, mutta CUDA:n väistämätöntä toimimattomuutta ei ole
osoitettu. Chromiumin luettu Windows-käytäntö käyttää LPAC:ia
kOnDeviceModelExecution-prosessityypille. Tämä ei todista meidän
llama.cpp-, CUDA- tai ajuriyhdistelmämme toimivuutta.
[Chromiumin Windows-käytäntö](https://github.com/chromium/chromium/blob/main/sandbox/policy/win/sandbox_win.cc)

Sovittu suunnitteluvaiheistus on pieni erillinen 4B/8B-yhteensopivuuskoe,
todellisen GPU-ajon ja prosessin elinkaaren mittaus sekä oma rajattu
eristyskoe. Ensimmäisen kokeen ympäristö ja oikeudet on sovittu
[kokeen lähtötiedoissa](../experiments/model-pilot.md).
Se käyttää synteettistä aineistoa ja tarkistettuja
malleja; sää-API tai oikea käyttäjäaineisto eivät kuulu tähän kokeeseen.
Synteettinen aineisto ei itsessään ole käyttöjärjestelmäeristys.

Vain säätyöntekijä nettiin säilyy havaintokäytön tavoitteena.
Tavallista malliprosessia ei merkitä tämän vaatimuksen täyttäväksi.
Jos OS-rajaa halutaan keventää laboratoriokäytössä, se päätetään erikseen
eikä päätös korvaa käyttöversion eristysnäyttöä. AppContainer/LPAC pysyy avoimena
mekanismina. Tarkat binäärit, CUDA-runtimet, ajurit ja valitun Electron-
version oikeudet tarkistetaan ennen toimivuus- tai turvallisuuslupausta.
[node-llama-cpp:n CUDA-ohje](https://node-llama-cpp.withcat.ai/guide/CUDA)

### Ulkoisen mallikansion tiedostoraja

Mallikansion valinta on käyttäjän asetustoiminto. Luotettu sovellusosa
luettelee tiedostot; GGUF-metatietojen tarkastus tehdään rajatussa
ympäristössä ennen hyväksymistä. Tarkastukselle tarvitaan koko- ja
aikarajat. Kansioon ilmestyminen ei ole lupa käynnistää mallia.

Valinnan jälkeen malliprosessi saa käyttöjärjestelmän rajaaman lukuoikeuden
vain tarvitsemiinsa hyväksyttyihin painoihin ja ohjelmaresursseihin.
Se ei saa kirjoitusoikeutta mallikirjastoon tai pääsyä käyttäjän muihin
tiedostoihin. Mallikirjaston sijainti ei laajenna verkkolupia.
Verkkopolut ja tiedostorajaa kiertävät linkit tai uudelleenohjaukset
hylätään. Tiedoston vaihto tarkistamisen ja lataamisen välillä käsitellään
toteutuksessa ja kokeessa; pelkkä tiedostonimi tai tarkisteen tallennus
ei takaa tiedostorajaa.

Kansio, painot ja chat-templatet eivät ole ohjelmakoodin tai lisäosien
hakupolkuja. Malli tai MCP ei valitse polkua eikä muuta hyväksyttyä luetteloa.
Tarkka OS-mekanismi ja soveltuvuus ulkoiseen kansioon todennetaan
eristyskokeessa. Käyttäjäpolun ja malliprofiilin omistaa
[mallisuunnitelma](local-model-plan.md#paikallinen-mallikansio).

### Suositus samaan asennuspakettiin

Sovittu päälinja on erillinen käyttöjärjestelmätasolla rajattu malliprosessi
sekä ohjelman ja moottorin yhteinen asennus. Vertailupainot pysyvät
erillisessä mallikansiossa. Windowsin AppContainer/LPAC jää arvioitavaksi
mekanismiksi. Tavallinen desktop-ohjelma voi käyttää AppContaineria
myös ilman MSIX-paketointia; MSIX voi hoitaa osan profiilin elinkaaresta.
Kummankaan paketointitavan nimeäminen ei vielä toteuta oikeusrajoja
([Microsoft: AppContainer desktop-ohjelmissa](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-for-legacy-applications-)).

AppContainer on Windowsin ominaisuus. Käyttäjälle ei sen vuoksi tarvita
Docker-, WSL-, Hyper-V- tai erillistä kielimallipalvelinasennusta.
Meidän toimitettavaksi jäävät luotettu käynnistysosa, moottori ja niiden
tarvitsemat resurssit; varsinaisen toimituksen omistaa
[mallisuunnitelma](local-model-plan.md#mallimoottorin-ja-painojen-toimitus).

AppContainer-profiili on käyttäjä- ja sovelluskohtainen
([CreateAppContainerProfile](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile)).
Ehdotus on luoda tai varmentaa se todellisen käyttäjän ensimmäisessä
käynnistyksessä. Konekohtaisen asentimen ylläpitäjätilille luotu profiili ei
hoida muiden käyttäjien profiileja. Jokainen malliprosessi on käynnistettävä
oikealla suojauskontekstilla; pelkkä profiilin luonti asennuksessa ei riitä.
Natiivin käynnistyksen toteutustapa ja mahdolliset konetason sääntöjen
oikeustarpeet selvitetään ennen valintaa
([Microsoftin käynnistysohje](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)).

Työmääräarvio on suunnitteluarvio, ei toteutuskokeesta saatu tulos:

| Osa | Arvio |
| --- | --- |
| Moottorin liittäminen asentimeen ja ulkoisen mallin käyttäminen | Rajattu toimituskoe; binäärit, tiedostoraja, lisenssit ja päivitys varmistettava. Koko mallikirjastoa ei paketoida. |
| Yhden malliprosessin CPU-ajo, verkkokielto ja rajattu viestiyhteys | Oma kohtalaisen vaativa tekninen koe; natiivit Windows-rajapinnat ja tiedostojen oikeudet. |
| GPU, paketoitu sovellus, virhepolut ja päivitykset | Vaativa osa; ajurit, resurssit ja suojausten säilyminen todennettava. |
| Koko Tähtiapurin vain säätyöntekijä nettiin -raja | Malliprosessia laajempi työ: myös main, backend, renderer ja mahdollinen MCP-sovitin tarvitsevat omat rajansa. |

Mallimoottorin CPU/GPU-yhteensopivuuden koe ja käyttöjärjestelmäeristyksen
koe erotetaan yllä kuvatulla tavalla. AppContainerin omaa toteutusta ei
lukita ensimmäiseksi työksi. Mahdollisen kevyemmän kokeen toteutustapa ja
oikeudet sovitaan ennen ajoa; sen tulos ei hyväksy havaintokäytön turvarajaa.
Tarvittava eristys ei saa poistua CPU-varatilassa tai virheestä palautumisessa.
Työmäärä tarkennetaan kokeen jälkeen. Täysi verkkoraja hyväksytään erikseen
[testausohjeen](../ai/testing-rules.md) näytöllä.

Yleisiä arvioitavia vastuita ovat mallin sovitin, rajattu käynnistys,
kontekstin välitys, resurssit, elinkaari ja niiden testit.
Sovelluksen mahdollisia pilvi- tai integraatioyhteyksiä ei tarvitse antaa
malliprosessille. Verkkopolitiikka suunnitellaan aina käyttötapauksen mukaan.
Kontti säilyy vertailu- ja laboratoriovaihtoehtona.

### Olemassa olevat vertailutoteutukset

Tarkistettu 3.11.2026 valmistajien dokumentaatiosta ja nimetystä lähdekoodista:

- [Chromiumin Windows-sandbox](https://chromium.googlesource.com/chromium/src/+/lkgr/sandbox/policy/win/sandbox_win.cc):
  SetupAppContainerProfile ottaa kOnDeviceModelExecution-tyypille käyttöön
  LPAC:n (SetEnableLowPrivilegeAppContainer(true)).
  Tämä on paikallisen malliprosessin eristyksen lähdekoodiesikuva.
- [Microsoft Edgen AppContainer-käytäntö](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/rendererappcontainerenabled):
  dokumentoi rendererin käynnistyksen AppContainerissa. Tämä tukee mekanismin
  käytännön käyttöä, ei väitettä kaikkien Edge-prosessien verkkokiellosta.
- [GPT4All Desktop](https://docs.gpt4all.io/gpt4all_desktop/quickstart.html):
  paikallinen mallisovellus, jonka ohjeessa malli ladataan asennuksen jälkeen.
  Esimerkki paikallisesta malliajosta, ei näyttö AppContainer-eristyksestä
  tai mallipainojen toimittamisesta samassa asentimessa.

Chromium-havainto koskee luettua lkgr-lähdettä (tiedostoblob
b6eccdade4f4d6d72acc975b097843e7f64b003a), ei omaa ajoa tai kaikkien
Chrome-asennusten todettua kokoonpanoa. Tarkistuksessa ei vahvistettu
valmista suoraan käytettävää Electron + llama.cpp + AppContainer + GPU
-kokonaisuutta. Eristysmekanismin käyttöesimerkki ei ole oman toimituksen
turvallisuushyväksyntä. Käynnistäjä, oikeudet, IPC ja ajuripolut arvioidaan
ja testataan omassa kokoonpanossa; mallin työkalupyynnöt tarkistetaan silti.

Käyttäjä piti Chromiumin mallia hyvänä vertailupohjana 3.11.2026.
Electron hyödyntää Chromiumin renderer-sandboxia
([Electronin eristysohje](https://www.electronjs.org/docs/latest/tutorial/sandbox)).
Tämä ei automaattisesti eristä erikseen käynnistettyä mallimoottoria.
Electronin utilityProcess tarjoaa Node.js-apuprosessin ja viestikanavat
([API-kuvaus](https://www.electronjs.org/docs/latest/api/utility-process));
se ei tämän perusteella ole valittu LPAC-käynnistäjä. Mallin oikeusrajat
ja niiden mahdollinen valmis Electron-tuki selvitetään ennen toteutustavan
valintaa. Chromium on vertailupohja, ei uusi hyväksytty kirjasto tai forkki.

### Kontti koeympäristönä

Kontti ja virtuaalikone eivät ole toisensa poissulkevia. WSL 2 käyttää
Linux-ydintä kevyessä virtuaalikoneessa
([Microsoftin WSL-kuvaus](https://learn.microsoft.com/en-us/windows/wsl/about)).
Docker Desktopin Linux-kontteja voidaan ajaa WSL 2 -ympäristössä
([Dockerin WSL-ohje](https://docs.docker.com/desktop/features/wsl/)).
Tämä ei ole päätös Docker Desktopista tai muusta konttiruntimesta.

Oikeusrajoiltaan erilaiset osat erotetaan omiin kontteihinsa tai vastaaviin
valvottuihin ympäristöihin. Yksi verkkoyhteydellinen kontti kaikille osille
ei toteuta tavoitetta. Saman mallimoottorin agenttiroolit voivat edelleen
jakaa yhden moottorin; jokainen rooli ei tarvitse omaa konttia.
Jos Electron tai backend jää Windowsiin, myös niiden ulospääsy on
estettävä käyttöjärjestelmässä. Mallin kontitus ei yksin rajaa koko sovellusta.

Mallikontin mahdollinen lähtökohta on ulkoisen verkkoliitännän poistava
`--network none`
([Dockerin none-verkkotila](https://docs.docker.com/engine/network/drivers/none/)).
Silloin backendin tavallinen TCP/HTTP-yhteys konttiin ei myöskään toimi.
Rajattu verkkoliitännästä riippumaton viestiväylä on kokeella selvitettävä;
aiemmin sovittua main–backend-IPC:tä ei muuteta tämän ehdotuksen perusteella.
Sääkontin FMI-ulospääsy rajataan erikseen. Kontin oletusverkko tai pelkkä
sisäverkon nimi ei ole todiste verkkopolitiikan toimivuudesta.

Ehdotetut konttirajat: ei privileged-ajoa, tarpeettomat capabilityt pois,
muu kuin root-käyttäjä, malli- ja ohjelmaresurssit vain luettavina, pieni
kirjoitustila sekä muisti-, CPU- ja prosessirajat. Ei kotihakemiston tai
repositoryn laajaa jakoa. Malli, säätyöntekijä ja MCP-sovitin eivät saa
konttiruntimen hallintaliitäntää. Konttikuvan alkuperä ja versio tarkistetaan;
kuvan hankinta/päivitys on erillinen ylläpitotoiminto.
[Dockerin oikeus- ja resurssiasetukset](https://docs.docker.com/engine/containers/run/)
ovat toteutuksen taustaa, eivät ajettu tai hyväksytty kokoonpano.

GPU arvioidaan valitulle moottorille ja laitteistolle. Docker Desktopin
dokumentoitu Linux-konttien `--gpus`-läpivienti Windowsissa käyttää WSL 2:ta
ja NVIDIA GPU-PV:tä; tätä ei yleistetä kaikkiin näytönohjaimiin
([Dockerin GPU-ohje](https://docs.docker.com/desktop/features/gpu/)).
Kontti jakaa ajoympäristönsä ytimen; sitä ei kuvata oman käyttöjärjestelmän
virtuaalikoneen kanssa samaksi eristysrajaksi.

Kontti on varteenotettava laboratoriovaihtoehto. Sen soveltuminen lopullisen
työpöytäsovelluksen vaatimukseksi on erillinen päätös: konttiruntime ja sen
Linux-ympäristö lisäävät asennus-, päivitys- ja resurssitarpeita.
Sovelluksen omien töiden ja konttien on sulkeuduttava sovelluksen mukana.
Konttiruntimen mahdollinen taustalle jääminen arvioidaan erikseen; sovittua
sovelluksen elinkaarta ei muuteta huomaamatta.

## Turvallisen koodin käytäntö

- Electron: sandbox, context isolation ja webSecurity säilyvät, Node pois
  rendereristä. Preload tarjoaa vain nimetyt toiminnot. CSP, navigointi,
  uudet ikkunat, webviewt ja laiteoikeudet rajataan oletuksena.
- Main tarkistaa IPC:n oikean ikkunan, pääkehyksen ja operaation.
  Backend tarkistaa lisäksi käyttötapauksen oikeuden, tilan, tietotyypit,
  kokorajat ja tuntemattomat kentät. Kuljetussovitin ei omista domain-sääntöjä.
- Malli ei hyväksy omia työkalujaan. Käyttötilan, havaintopaikan ja
  säähaun käynnistystavan omistaa sovellus; säärooli on tavallista koodia.
  Historia tai ulkoinen data ei voi vaihtaa näitä salaa.
- Sääpyynnön tarjoaja, HTTPS-kohde, metodi ja kyselyrunko ovat kiinteästi
  rajatut. Ei mallin URL:ia, otsakkeita tai vapaata hakutekstiä.
  Uudelleenohjaukset estetään; TLS-varmennusta ei ohiteta. Rajataan aika,
  koko, uusinnat ja kutsutiheys. XML-parseri ei lataa ulkoisia entiteettejä,
  DTD:tä tai skeemoja. Backend tarkistaa myös normalisoidun säävastauksen.
- Malli- ja API-teksti näytetään tekstinä tai rajatulla turvallisella
  renderöinnillä. Ei raakaa HTML:ää, automaattisia linkkien/kuvien hakuja,
  evalia tai syötteestä rakennettua shelliä, SQL:ää tai tiedostopolkua.
- Tallennus pysyy omassa datajuuressa; polkujen ja tiedostojen käsittely
  torjuu juuren ohituksen. Kirjoituksen eheys ja historian poistaminen
  noudattavat tiedon elinkaaren sopimusta. Salaisuudet ja oikeat
  koordinaatit/keskustelut eivät kuulu jaettaviin lokeihin tai testeihin.
- Riippuvuudelle tarvitaan tarkoitus, lisenssi ja tunnettu alkuperä.
  Täsmäversioiden, lukitustiedoston, natiivibinäärien ja malliresurssien
  eheys sekä soveltuvat turvallisuustiedotteet tarkistetaan käyttöönotossa
  ja päivityksissä. Tarkistus ei tarkoita automaattista päivitystä.

## MCP-kehitysyhteyden lisäraja

[Mallisuunnitelma](local-model-plan.md#kehitys--ja-diagnostiikkarajapinta-paikalliseen-malliin)
omistaa kolmen operaation, asetusten kytkimen, todentamisen, kontekstien
erottelun ja peruutuksen sopimuksen. Sovittu
[kehitysyhteyskytkin](local-model-plan.md#kehitysyhteyden-kytkin)
katkaisee backendin kehityspääsyn Codexin asetuksesta riippumatta. Sovitin ei peri kehittäjän laajoja oikeuksia:
sille rajataan oma prosessiympäristö, tiedostopääsy ja ulkoinen verkko.
MCP:n virallinen ohje suosittelee paikalliselle palvelimelle stdiota ja
käyttöjärjestelmän vähimpiä oikeuksia
([MCP:n turvallisuusohje](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices#local-mcp-server-compromise)).

Codexin komentohiekkalaatikon rajoja ei voi olettaa MCP-prosessin rajoiksi;
OpenAI dokumentoi näille erilliset hallintapinnat
([OpenAI Docs: oikeuksien soveltamisala](https://learn.chatgpt.com/docs/permissions#scope-and-enforcement)).
Koetulos on epäluotettua aineistoa, ei uusi valtuutus Codexille. Kehityksen
GitHub-oikeuksia ei välitetä sillan kautta mallille tai sovellukselle.

## Vertailun rajaus

Muiden sovellusten vertailu auttaa suunnittelussa. Tähtiapurin
turvallisuustavoitteiden hyväksyntä perustuu sen omiin kokeisiin,
testinäyttöön ja toimitettavaan kokoonpanoon. Toisesta sovelluksesta
löytynyt kontrolli ei osoita Tähtiapurin prosessien eristyksen toimivuutta.

## Hyväksymisnäyttö ennen verkkokäyttöä

[Testausohje](../ai/testing-rules.md#toistettavuus-ja-ajamisen-rajaus)
omistaa sallitun ja kielletyn liikenteen, tiedostorajojen, MCP:n ja
kontekstien erottelun todelliset kokeet. Sovelluksen torjunta erotetaan
käyttöjärjestelmän estosta. Pelkät funktiotestit tai koodikatselmus eivät
ole eristysnäyttö.

Ennen ensimmäistä sääverkkokoetta T09 todentaa rajat minimaalisella
koepaketilla: desktop-runko, backend, mallimoottori, rajattu sääkoetoiminto
ja käytössä oleva MCP-sovitin. Koelupa koskee vain tätä testattua
kokoonpanoa. T15:n lopullinen asennin ei ole tämän varhaisen kokeen edellytys.
Ennen havaintokäytön hyväksymistä T16 toistaa näytön juuri lopullisella
toimitettavalla kokoonpanolla. Vaiheet omistaa
[roadmap](../planning/roadmap.md).

Avoinna ovat natiivin Windows-eristyksen, kontin ja virtuaalikoneen vertailu,
kehitys-IPC:n kutsujan todentaminen, mallikanavan/GPU:n yhteensopivuus,
FMI-kyselyn tarkka sopimus sekä riippuvuuksien versiot. Mikään näistä
ei ole tämän suunnittelutekstin perusteella toteutettu tai hyväksytysti testattu.
