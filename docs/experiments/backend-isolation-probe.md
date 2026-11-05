# Nykyisen backendin rajattu eristyskoe

Tämä issue #10:n osakoe liittää nykyiset backend-palvelut erilliseen,
koekohtaiseen Node-prosessiin. Koe käyttää synteettisiä havaintopaikkoja,
paikallista tähtikatalogia ja mallin vastauksia jäljittelevää omistajasovitinta.
Sovelluksen oletusbackend, oikeat käyttäjätiedot, MCP ja mallimoottori säilyvät
ennallaan. Eristyksen jatkoportit omistaa
[backendin ja MCP:n suunnitelma](../architecture/backend-mcp-isolation.md).

## Koepaketti ja oikeudet

Kokeen oma entry koostaa nykyiset createBackend-, observing-, sky- ja
assistant-palvelut. Omistaja käyttää nykyistä BackendControlleria;
sen käynnistys-, heartbeat-, pyyntöaika- ja kapasiteettirajoja ei pidennetä.
Resurssien kopiointi ja suspendatun lapsen tarkistus tehdään ennen
controllerin käynnistämistä.

Suljettu riippuvuusluettelo sisältää virallisen lukitun Noden, koepäätteen,
28 nykyistä JS-tiedostoa, alkuperäiset tarvittavat pakettimetatiedot sekä
tähtikatalogin. SDK:ta, mallipainoja tai koko node_modules-puuta ei kopioida.
Lähteen PNPM-tiedostosta kopioidaan tarkistetut tavut uudeksi tiedostoksi;
koepaketissa ei sallita linkkejä. Generoitu natiivin käynnistimen pin-luettelo
lukitsee polut, koot ja SHA-256-tarkisteet. Käynnistin tarkistaa koko puun
ja pitää koodi-/katalogitiedostojen lukukahvat auki elinkaaren loppuun.
Erillinen ei-suoritettava code.txt-koetiedosto tarkistetaan, mutta sen
kirjoitusta ei estetä jakolukolla.

Kukin case-juuri sisältää suojatun omistusmerkin, oman synteettisen data/-
hakemiston ja yhden worker-juuren. Työntekijä saa koodin ja katalogin lukuun
sekä data/- ja scratch-puut kirjoitettaviksi. Väliaikaistiedoston atominen
korvaaminen tarvitsee myös poisto-oikeudet näiden puiden sisällä.
Koko puu validoidaan ja koodin sekä katalogin lukukahvat avataan ennen DACL-muutoksia. Suojatut,
eksplisiittiset ACL:t asetetaan tiedostoille ja sen jälkeen hakemistoille
alhaalta ylöspäin; worker- ja case-juuret muutetaan viimeisinä. Näin vanhojen
periytyvien ACE:iden poistaminen ei tyhjennä vielä suojaamattoman lapsen
DACL:ää. [Windowsin periytymiskäytäntö](https://learn.microsoft.com/en-us/windows/win32/secauthz/automatic-propagation-of-inheritable-aces).

Case-juureen saa vain metatietojen luku- ja kulkuoikeudet. Omistusmerkit
ovat luettavia, mutta niiden muuttaminen tai poistaminen ei kuulu granttiin.
Private-fixture jää ulkopuolelle. AAP-lukufixture erottaa LPAC-ehdokkaan
kontrollista.

Kontrolli käyttää tavallista medium-tokenia (integrity 8192). Eristetty ehdokas käyttää LPAC-pyyntöä
ja täsmällistä registryRead-capabilityä; se ei ole lopullinen toimitusprofiili.
Suoran LPAC-lippukyselyn mahdollinen null/87/0 säilyy epävarmana.
DETACHED_PROCESS, konsolin puuttumisen kaksi tarkistuspistettä, kolme
nimettyä standardiputkea ja Job tarkistetaan aiemman
[Node-stdio-kokeen](node-stdio-probe.md) mallilla. Jaettua mallikäynnistintä
ja mallin nollacapability-politiikkaa ei muuteta.

Job sallii yhden prosessin, yhden suorittimen, BelowNormal-prioriteetin ja
512 MiB commit-muistia. Käynnistimen määräaika on 20 sekuntia myös
suspendatun valmistelun, oikeuksien palautuksen ja loppuraportin aikana.
Omistajan EOF, KILL ja määräaika toimivat erillään tukkeutuneesta kirjoittajasta.

## TBIP-viestiyhteys

Kokeella on oma 48 tavun binääriotsake: TBIP, versio, laji, kasvava
suuntakohtainen järjestysnumero, hyötykuorman tavumäärä ja 32 tavun nonce.
Omistajan ja työntekijän nonce-joukot ovat erilliset. Native broker käärii
omistajan JSON-pyynnön sisempään kehykseen; omistaja ei lähetä valmiiksi
sisäkkäistä kehystä.

Työntekijän tavut kulkevat CHILD_CHUNK-kuorissa. PREPARED-, STARTED-,
STDERR- ja RESULT-kuitit tulevat aina natiivin brokerin samasta sarjallisesta
kirjoittajasta. Työntekijä ei voi tuottaa näitä ulompia kuittityyppejä.
Omistaja tarkistaa sisemmän kehyksen, tiukan UTF-8:n ja nykyiset
sovellusvalidaattorit. Ensimmäisen sovellusviestin on oltava aidon backendin
ready. Täysi 5 079 kohteen taivasvastaus kulkee kanavan läpi; yhteenveto tai
pelkkä työntekijän laskema tarkiste ei korvaa sitä.

| Raja | Koepolitiikka |
| --- | --- |
| Omistajan JSON-pyyntö | 64 KiB |
| Työntekijän JSON-vastaus | 16 MiB |
| Sovellusviestejä kumpaankin suuntaan | Enintään 256 |
| Sovellushyötykuormat yhteensä | 4 MiB sisään, 64 MiB ulos; otsakkeet lisäksi |
| Natiivin jono kumpaankin suuntaan | 256 KiB, aktiivinen kirjoitus mukana |
| Ulompi datalohko / lohkoja | 64 KiB / enintään 2 048 |
| JS-kirjoitusjono | 32 viestiä, 32 MiB; omistajan jono 1 MiB |
| Ohjauskuitti / kuittien tavut | 16 KiB / 256 KiB |
| Stderr | Yksi raakatavukuitti, enintään 16 KiB, myös tyhjänä |

16 MiB:n raja on johdettu nykyisistä tietotyypeistä. Validaattorin hyväksymä
pakomerkeillä suurennettu synteettinen 5 079 kohteen todistaja sarjallistui
14 304 163 tavuksi. Raja tarkistetaan silti todellisista koodatuista tavuista;
skeema ei yksin rajoita mielivaltaista JSON-tekstiä tai sarjallistuskoukkuja.
Parseri validoi otsakkeen ennen hyötykuorman varausta ja kopioi fragmentit
lineaarisesti.

## Sulku ja säilyvä data

PREPARED tarkoittaa tarkistettua, vielä suspendattua Node-lasta. START
jatkaa sitä; STARTED jonotetaan ennen työntekijän ulostulon välittämistä.
ChildPortin spawn ja pid viittaavat tähän lapseen.

Vasta täsmäävä runtime.shutdown-vastaus sallii CLOSE_CHILD_INPUT-ohjauksen.
Se odottaa edellisten pyyntöjen kirjoittamista. Työntekijä odottaa hyväksyttyä
shutdownia, observing-palvelun sulkua, ehjää EOF:ää ja ulostulon tyhjenemistä.
Omistajan oma broker-yhteys pidetään auki. Kirjoittajan seal sulkee uusien
viestien hyväksymisen lähettämättä omistajakanavaan EOF:ää.
Noden lapsiprosessisovitin voi sulkea stdin-kahvan brokerin poistuttua ennen
puskuroidun RESULTin lukemista. Vain omistajan kirjoittaja saa odottaa tätä
vertaissulkua, kun CLOSE_CHILD_INPUT on kirjoitettu kokonaan eikä jonossa ole
työtä. Kesken olevan kirjoituksen katkeaminen on yhä virhe. KILL säilyy
mahdollisena putken ollessa auki; lopputulos vaatii edelleen kaikki kuitit,
ehjän ulostulon ja brokerin todellisen poistumisen.

Jobin tyhjentymisen jälkeen käynnistin tarkistaa data-puun uudelleen ja
palauttaa jokaiselle objektille suojatun, vain eksplisiittisen omistajan ja
SYSTEMin DACL:n. Sama koskee säilyvää case-juurta ja sen omistusmerkkiä.
Kävely ja hakemistoluvun muistinkäyttö rajataan 128 objektiin ja kahdeksaan
tasoon; linkki tai epävarma palautus hylkää tuloksen. Profiili poistetaan vasta
tämän jälkeen. RESULT erottaa persistentAclRestored-, profileDeleted-,
Job-, stderr- ja konsolihavainnot.

Vain vahvistettu sulku saa näkyä puhtaana ChildPort-exitinä. Puuttuva kuitti,
virheellinen kanava tai epävarma siivous säilyttää työjuuren. Säilyvä data on
erillinen onnistumisehto: uusi istunto saa käyttää samaa datajuurta vasta
edellisen lapsen ja brokerin poistuttua, oikeuksien palaututtua, profiilin
poistuttua ja vanhan worker-juuren poistuttua. Koko tapauksen lopussa myös
säilyvä case-juuri poistetaan. Uudelleenkäynnistysnäyttö arvioidaan erikseen.

## Ajaminen ja näyttöraja

Nykyisillä Windows C++ -työkaluilla, projektijuuresta:

~~~powershell
powershell -NoProfile -File tests/e2e/isolation/build-backend-probe.ps1
powershell -NoProfile -File tests/e2e/isolation/run-backend-probe-limited.ps1 -Mode unit
powershell -NoProfile -File tests/e2e/isolation/run-backend-probe-limited.ps1 -Mode normal
~~~

Ensimmäinen runtime-portti on kontrollin normaalitapaus ja sen jälkeen
LPAC-ehdokkaan normaalitapaus. Ensimmäinen odottamaton virhe pysäyttää sarjan.
Katalogin luku, observing-tallennus, kokonainen taivasvastaus, mock-mallin
onnistuminen/peruutus/virhe ja todellinen prosessisulku tarkistetaan.
Lähteet ja rakentamisen tulot/tulokset sidotaan tarkisteisiin.

Kohdistetut 49 testiä läpäisivät. Ensimmäinen Windows-kontrolli pysähtyi
ennen lapsen luomista: liian aikainen ylähakemiston DACL-muutos poisti
alihakemistojen perityt oikeudet. Rajattu lukudiagnoosi todensi tyhjät
DACL:t. Epäonnistunut työtila säilyy muuttumattomana; sen jälkeen ei ajettu
LPAC-tapausta. Korjattu alhaalta ylöspäin tehtävä suojaus sekä odottamattoman
lapsipoistumisen jonon keskeytys katselmoitiin ennen uutta kontrollia.

Korjattu kontrolli ja LPAC-ehdokkaan normaalitapaus läpäisivät. Molemmat
käsittelivät observing-tallennuksen, vanhan revision hylkäyksen, kokonaisen
5 079 kohteen taivasvastauksen, saman vastauksen välimuistista, kohdevalinnan
ja mock-mallin onnistumisen, peruutuksen sekä virheen. Omistaja validoi
molempien koko taivasvastauksen. Sovellusviestit kulkivat aidon kanavan läpi.

Kummassakin lapsi ja broker poistuivat, Job tyhjeni, säilyvän datajuuren
DACL:t palautettiin ja worker- sekä case-juuret poistettiin. LPAC-ajon
profiilin poisto vahvistui; kontrollissa ei luotu profiilia. Stderr valmistui tyhjänä. Kontrollin kuusi tiedostotoimintoa
onnistuivat; LPAC-ehdokkaassa sallittu paketin luku ja scratch-kirjoitus
onnistuivat, private-luku/-kirjoitus, koodikirjoitus ja AAP-luku estyivät.
Suora LPAC-lippukysely säilyy null/87/0-havaintona.

Riippumaton lähde- ja raakanäyttökatselmus vaaditaan ennen osavaiheen
hyväksyntää. Tarkka koonti ja avoimet hyväksymisehdot kirjataan issueen #10;
raakadata ja aiempien kielteisten kokeiden näyttö säilyvät .artifacts/-puussa.

Verkkoyrityksiä, FMI-hakua, MCP:tä, oikeaa mallia, GPU:ta tai lopullista
asennuspakettia ei testata tässä portissa. networkVerified pysyy false-arvossa.
Normaalitapaus ei korvaa backendin erillisiä EOF-, virhe-, vastapaine- ja
uudelleenkäynnistyskokeita eikä koko issue #10:n hyväksyntää.
