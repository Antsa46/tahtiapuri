# Natiiviapurien käynnistysvalvoja

Tila: Main-valvoja, Worker-sovitin ja Hostin pakollinen resurssilataaja
jakavat saman pakettiin sidotun omistajan. BC:n 306 tapauksen mock-/Node-
komponenttivalinnan jälkeen hyväksyttiin myös BD:n rajattu hakemistoskriptikoe,
BE:n kolmen resurssikutsun koe ja BF:n kaksi erillistä oikeaa Host-tapausta.
BF:n Host-ajot käyttivät suoraa compiled-importia. Nykyisellä lazy-import-
fixturellä on tyypitys-, keräily- ja import-only-näyttö, ei uutta oikeaa Host-ajoa.
Ajantasaisen näyttörajan omistaa [BF:n rajattu näyttö](#node-isännän-rajattu-testinäyttö).
Oletus-Electron-koostaminen ja koko sovelluksen oikeusmatriisi ovat edelleen
avoinna. Alla vanhan vaiheen ajamattomuusväite koskee vain nimettyä vaihetta.

BC:n suljettu valinta on tests/support/mcp/native-directory-grant-vitest.config.mjs.
Aiemmat 199/93/180/170/106/81/70/56 sarjat ovat osin samoja testejä,
eikä niiden tapausmääriä summata.

Aiempaa käynnistyssovitinta käyttänyt oikea identity–recover-Node/Worker-koe läpäisi molemmat
operaatiot todellisilla lapsen close- ja säikeen exit0-havainnoilla. Ensimmäinen
neljän sekunnin identity-koe säilyy epäonnistuneena. Pakettiin sidotun
resurssipolun kahden apurikutsun koe läpäisi myös;
sen näyttö on kuvattu erikseen alla. Sovelluksen oletuspolkuun kytkentä,
Electron ja oikean Workerin myöhäisten virhe-/sulkupolkujen näyttö
ovat kesken. Aiempi Node-säikeen kellokoe, recover-kehyksen 13 CLI-tapausta
ja koesarjan omistajan seitsemän mockregressiota ovat erillistä näyttöä.
Tämä dokumentti omistaa valvojan sopimuksen. Käyttöjärjestelmän oikeudet
kuuluvat [turvallisuussuunnitelmaan](security-and-permissions-plan.md).

## Vastuut ja tulokset

Valvoja on Mainin luotettua koodia, ei uusi eristysraja.
worker_threads-säie omistaa yhden apurin koko ChildProcess-elinkaaren.
Main omistaa pyynnön, alkuperäisen absoluuttisen määräajan, peruutuksen ja
valtuustiedon. Kutsuissa ei ole vapaata ohjelmaa, argv:tä, ympäristöä tai
worker-URL:ia. Pakettiin sidottu composition muodostaa kiinteän adapterin
identity-, directory-, bootstrap- tai session-operaatioille.

Saman Mainin elinkaariomistaja säilytetään myös epävarmuuden jälkeen.
Yksi pyyntö saa olla keskeneräinen; odotusjonoa, omistajan nollausta,
korvaavaa apuria tai automaattista uudelleenkäynnistystä ei ole.

- result on alkuperäinen tulos tai virhe. Kuljetustuloksen stdout tarvitsee
  edelleen operaation täsmällisen kuitin tai identity-rakenteen tarkistuksen.
- settled on myöhempi valvontatietue. Se erottaa lapsen todellisen sulun,
  workerin päättymisen ja epävarmuuden. Lupauksen täyttyminen ei yksin todista
  kaikkia prosesseja suljetuiksi, eikä myöhäinen havainto korota aiempaa virhettä.

Aikaraja voi palauttaa virheen workerin vielä odottaessa synkronisen
käynnistyskutsun paluuta. Main säilyttää kahvan ja worker jatkaa omistetun
lapsen havainnointia. Workeria ei lopeteta ja unohdeta mahdollisine lapsineen.
Vanhan portin viestit ja virheet aidataan sen terminaalitilalla.

## Valtuus ja määräaika

Main kopioi syötteen synkronisesti. Käynnistyspyyntö ei sisällä valtuustavuja.
Workerin started kertoo vain käynnistyskutsun paluusta ja asennetuista
virhe-/sulku-/putkihavainnoista, ei natiivin valmiudesta. Voimassa olevalle
pyynnölle Main voi tämän jälkeen lähettää yhden authorize-viestin.

Yhteisessä atomisessa sanassa ovat CANCELLED- ja COMMITTED-bitit. Main
peruuttaa ennen muuta käsittelyä. Worker saa suorittaa eksplisiittisen
stdin/EOF-toiminnon vain onnistuneen OPEN → COMMITTED -CAS:n jälkeen.
Määräaika ja peruutus tarkistetaan vielä commitin jälkeen ennen kirjoitusta.
Jos commit voitti kilpailun, mahdollinen valtuuden toimitus säilyy
konservatiivisena havaintona, vaikka myöhempi tarkistus estäisi kirjoituksen.

Määräaika muodostetaan kerran ennen workerin luontia: pienempi omistajan
alkuperäisestä absoluuttisesta määräajasta ja nykyhetkestä + 20 sekuntia.
Main ja worker hylkäävät yli 20 sekunnin tulevaisuuteen annetun rajan.
Katto kattaa säikeen latauksen, synkronisen spawnin, valtuutuksen ja
onnistuneen lapsen sulun sekä säikeen päättymisen. Lyhyempi kutsujan
määräaika säilyy. `started` ei aloita uutta budjettia. Tämä on uusi
käynnistyssopimus; aiempia neljän/kuuden sekunnin kokeita ei tulkita sen avulla
uudelleen. Havaittu viive ei osoita sen aiheuttajaa.

Mainin alkuperäinen 30 sekunnin sulku ja C++-natiiviapurien oma viiden
sekunnin watchdog stdin-odotuksineen säilyvät. Directory-roolin PowerShelliä
rajaa sama Main/Worker-määräaika; sille ei väitetä C++-apurien sisäistä watchdogia. Myöhempi composition välittää sulun
jäljellä olevan alkuperäisen ajan; uusi 20 sekunnin allowance ei jatka sitä.
Timeout tai cancel ennen commitia estää syötteen. Commitin jälkeen
mahdollinen vaikutus ja epävarmuus säilyvät myös myöhäisen sulkuhavainnon jälkeen.

## Kiinteä worker ja rajattu ajonäyttö

Sovitin lataa vain compiled `native-launch-worker.js`-entryn. Sen todellinen
runtime-ketju on core → config, gate, recovery-grant ja directory-grant;
Main-puoli sitoo lisäksi portin, valvojan sekä validation/public-riippuvuuden.
Worker käyttää tyhjää execArgv:tä, argv:tä ja ympäristöä. Muut lapsiroolit saavat
enintään neljä erikseen hyväksyttyä ympäristöavainta. Directory-rooli saa lisäksi
sidotun TAHTIAPURI_PRIVATE_DIR-avaimen. Suljettuja operaatiomuotoja on nyt
kymmenen: aiemmat yhdeksän ja directory. SystemRoot sidotaan kanonisesta,
luotetusta Main-ympäristöstä, eikä operaatiopyyntö valitse järjestelmäohjelmaa.

Yksi loader-kutsu varaa Main-moduulin elinkaaren ennen validointia tai I/O:ta.
Lähde-/eval-entryä, omistajan resettiä tai Worker.terminate/unref-varareittiä
ei ole. Kolmen natiiviohjelman ja kuuden worker-tiedoston koko/hash tarkistetaan
riippumattomasti hyväksytyistä pinneistä. Saman käyttäjän tai ylläpitäjän
sovelluskoodin muutos on luottamusrajan sisällä; tarkistus ei ole Windowsin
kirjoittamisen/poiston estävä ohjelmakahva. Worker on luotettua sovelluskoodia,
ei käyttöjärjestelmän eristysraja.

Alla olevien aiempien oikeiden kokeiden Worker-sulkeumassa oli viisi moduulia,
eikä niissä ollut directory-roolia. Uuden roolin rajattu mock-/controller-näyttö on mukana edellä mainitussa
306 tapauksen BC-sarjassa. Tämä sarja ei yksin todista grant-/ACL- tai
Worker–Host-ketjua. Myöhemmän BD-/BE-/BF-näytön rajaus on
[BF:n yhteenvedossa](#node-isännän-rajattu-testinäyttö).

Ensimmäinen oikea Node-koe käynnisti vain identity-pyynnön ja pysähtyi noin
neljän sekunnin rajaan. Recoveriin, fixturekirjoitukseen tai valtuutukseen ei
edetty. Ensisijaisen kuitin erillinen yhden sekunnin loppuhavainto jäi ilman
settlement-tulosta. Node päättyi myöhemmin luonnolliseen exit1:een, mutta se
ei korvaa puuttuvaa historiallista lapsen close-/worker-exit-kuittia.
Ajossa kerätyt Main-sydämenlyöntinäytteet kattavat vain ensisijaisen
raportoinnin havaintovälin. Ne eivät kuvaa koko prosessin myöhempää elinaikaa,
pahimman tapauksen viivettä tai viiveen syytä. Konekohtaiset mittausluvut
säilyvät paikallisina. Viiveen syy jää avoimeksi.

Testiomistaja asentaa alkuperäisten result/settled-lupausten havainnot ennen
odotuksia. Ensisijaisen kuitin jälkeen saapuva settlement voi kirjoittaa yhden
erillisen myöhäisen kuitin operaatiota kohti. Kuitti ei korvaa alkuperäistä
virhettä tai tiedostoa. Diagnostiikan oma yhden sekunnin katto ei jatka
operaation onnistumisaikaa; keskeneräinen kirjoitus säilyy havaittuna ja
kirjoitusvirhe tai puuttuva kuitti jättää näytön puutteelliseksi. Uutta aktoria
ei käynnistetä. Seitsemän determinististä mockregressiota läpäisivät:
molempien alkuperäisten lupausten havainto, myöhäinen sulkukuitti muuttamatta
ensisijaista virhettä, kirjoitusvirhe, keskeneräinen kirjoitus yli oman rajan,
settlementin hylkäys, ensisijaisen havainnon uudelleensulkemisen esto ja
jonossa viivästyneen kirjoituksen estyminen ilman timer-dispatchia.
Oikean Workerin myöhäistä kuittia ei vielä todennettu ajossa.

Uusi oikea koe käytti kiinteää compiled-porttia ja samaa Main-valvojaa kahteen
peräkkäiseen operaatioon. Identityn täsmällinen JSON-kuitti sisälsi oman PID:n
ja ei-nollan FILETIME-arvon; LF/CRLF hyväksyttiin tuotannon parserin tavoin.
Vasta onnistuneiden result/settled-havaintojen jälkeen luotiin synteettinen
pending-fixture. Recover sai Mainin kiinteän THREC001-kehyksen, palautti tarkan
kuittinsa ja poisti fixturen natiivisti. Molempien lapsien close ja säikeiden
exit0 havaittiin; valtuusbitti oli identitylle false ja recoverille true.
Loppukuitti ja ulompi prosessihavainto osoittivat onnistumisen, eikä omistajalle
jäänyt keskeneräistä työtä tai epävarmuutta. Mitään ei lopetettu pakolla.

Koe ei käynnistänyt broker-operaatiota, MCP-workeria, mallia, GPU:ta,
sää-APIa tai Electronia. Yhden onnistuneen ajon nopeudesta ei päätellä
cold-start-suorituskykyä tai aiemman viiveen ratkeamista. Se ei myöskään
hyväksy oikeita cancel-/myöhäis-/crash-polkuja, Main-koostamista tai koko
sovelluksen oikeusrajoja.

## Semanttinen kutsusovitin (kesken)

NativeLaunchOperations kuuluu nyt pakettiin sidottuun resurssipolkuun;
sovelluksen oletuskoostaminen on vielä avoin. Sen kutsuissa on vain
directory-, identity-, bootstrap- tai session-operaatio, tarvittaessa oma 96 tavun descriptor,
alkuperäinen omistajan bigint-määräaika ja peruutussignaali. Resurssikoostamisen
on muodostettava omistajan alkuperäinen budjetti jo ennen uudelleenvarmennusta;
sovitin ei anna sille uutta aikaa. Varattu bridge estää rinnakkaisen dispatchin
ennen ensimmäistä callbackia. Transportti- tai semanttinen virhe sulkee sen
pysyvästi, vaikka myöhäinen settlement myöhemmin saapuisi.

Sovitin luottaa aidon NativeLaunchSupervisorin deadline- ja
settlement-sopimukseen. Sen Owner-tyyppi ei ole yleinen plugin-rajapinta eikä
sovitin itsenäinen mielivaltaisen kuljettajan aikakatkaisija.

Sovitin säilyttää alkuperäisen task.result/task.settled-parin. Virhe voi palautua
ennen sulkua; semanttinen onnistuminen vaatii molemmat, oikeat valtuusbitit ja
saman deadlinen/abortin tarkistuksen vielä ennen palautusta. Väärä kuitti
havaittujen child-close/Worker-exit0-tulosten jälkeen eroaa tuntemattomasta
sulusta. Alkuperäisen transporttivirheen exitVerified/authorityCommitted-arvoja
ei koroteta jälkikäteen.

Identityn pure-codec tarkistaa tavut ennen tekstimuunnosta: vain ASCII,
täsmällinen LF/CRLF, oma PID ja ei-nollainen 64-bittinen FILETIME. Vanhan
execFile-polun käynnistys, timeout, stderr ja close-käsittely säilyvät; vain
kuittidekoodaus on poimittu yhteiseksi. Muiden operaatioiden kuitit verrataan
Buffer.equals-kutsulla. Proben aiempi ASCII-muunnos on myös korvattu tarkalla
codecilla/tavuvertailulla. Tämä tiukennus ei selitä aiempaa viivettä tai kumoa
pinnatun apurin aiempaa onnistumista. Muutettua probea ei ole ajettu uudelleen.

Uusi identity-codec läpäisi seitsemän ja semanttinen sovitin 18 mocktapausta.
Mukana ovat alkuperäinen lyhyempi omistajabudjetti, reentrant/rinnakkaisen
dispatchin esto, yksityinen descriptor-kopio, molempien lupausten vaatimus,
väärä kuitti tunnetun sulun jälkeen, virhe ja myöhäinen settlement,
deadline/abortti transportin ja semanttisen palautuksen välissä,
ristiriitaiset valtuusbitit, settlement-hylkäys sekä valmiiksi varattu tai
epävarma omistaja. Desktop-build, seitsemän TS-testitiedoston tyypitys ja
koko 106 tapauksen mockvalinta läpäisivät; riippumaton tarkastaja vahvisti
rajatun näytön. Tässä 106 tapauksen vaiheessa tiukennettua oikeaa worker-probea
tai uutta sovitinketjua ei vielä ajettu. Myöhempi resurssipolun ajonäyttö on
kuvattu erikseen alla; tiukennettu vanha worker-probe säilyy ajamatta.
Sovelluksen oletusliitosta ei ole tehty; myöhemmät rajatut Host-kokeet on
erotettu [BF:n näytössä](#node-isännän-rajattu-testinäyttö).

## Pakettiin sidottu resurssiomistaja (kesken)

Tehdas muodostaa verifierin ja Worker/Operations-omistajan
samasta ulkoisella descriptor-hashilla hyväksytystä paketista. Config ei valitse
niitä erikseen. Recovery-hyväksyntä kohdistuu nimenomaisesti samaan descriptoriin;
THREC001:tä ei päätellä paketin omasta ilmoituksesta. ControlFile sidotaan kerran
tehtaassa eikä sitä anneta operaatioiden argumenttina. Tehtaan Main-elinkaaren
varaus tehdään ennen ensimmäistä async-työtä, eikä epäonnistuminen vapauta sitä.

Tehdas säilyttää alkuperäisen valmistelulupauksen ja palauttaa erillisen,
alkuperäiseen määräaikaan/peruutukseen sidotun tuloksen. Myöhäinen alkuperäinen
resolve/reject ei korvaa jo palautunutta virhettä, luovuta uutta omistajaa tai
käynnistä seuraavaa latausvaihetta. Monotonic-raja tarkistetaan luovutushetkellä
myös ilman timer-dispatchia. Taustalla odottavaa I/O:ta ei väitetä peruuntuneeksi.

Natiiviapurille menevä resurssikutsu varaa omistajan synkronisesti ja kopioi
tarvittavan descriptorin ennen verifierin awaitia. Kellomuunnos lukee hrtime-arvon ensin ja performance-
arvon vasta sen jälkeen; jäljellä oleva aika pyöristetään alaspäin ja rajataan
20 sekuntiin kerran ennen I/O:ta. Sama bigint-raja kulkee Operationsille.
Myöhäinen verify-tulos tai abortti ei aloita natiividispatchia. Alkuperäinen
verify-lupaus säilyy omistettuna myös erillisen tulosrajan jälkeen. Natiivivaiheen
määräajasta ja result/settled-kuiteista vastaa edelleen aito Operations/Supervisor.

Lukuvarmennin tarkistaa alkuperäisen descriptor-pinnin, build-manifestin sekä
kolme kiinteää ohjelmaa. Se ei kutsu legacy-helpereitä tai palauta uusia
polkuvalintoja. Saman käyttäjän/ylläpitäjän luottamusraja ja native-handle-pinnin
puuttuminen säilyvät. Vanha NativeMcpRuntime palauttaa edelleen saman rajapinnan;
uusi launch-source ei altista sen suoria suoritusmetodeja. Samaan pakettiin
sidottu uusi staging-kyvykkyys kuvataan erikseen alla.

Resurssiosan lähde- ja raakanäyttökatselmus, desktop-build sekä kymmenen
TS-testitiedoston tyypitys läpäisivät. Uudet 18 resurssiomistajan ja 20 tehtaan
mockia sekä laajennettu 26 tiedostoresurssin sarja läpäisivät osana 170 valintaa.
Ensimmäinen AW-putki pysähtyi testin readonly-delete-tyypitykseen ennen
koesarjaa; vain fixturetyypin korjaus edelsi uutta onnistunutta ajoa.
AW:n tässä vaiheessa Host-liitosta ei ollut tehty. Myöhemmän rajatun
Host-liitoksen omistaa [BF:n näyttö](#node-isännän-rajattu-testinäyttö);
sovelluksen oletuspolku säilyy avoimena. Kahden resurssikutsun AY-näyttö
on kuvattu erikseen alla. Sovelluksen oletuspolun avausbudjetti on avoin
valinta. Host säilyttää alkuperäisen 30 sekunnin cleanup-rajan, ja staging
käyttää nyt samaa alkuperäistä avausrajaa pakollisen loader-portin kautta.

## Kutsukohtainen havaintokahva (kesken)

Operations ja resurssiomistaja säilyttävät jokaisen julkisen kutsun alkuperäisen
Promisen WeakMap-avaimena. observeCall(original) palauttaa juuri siihen sidotun,
jäädytetyn havaintokahvan. Tuntematon Promise hylätään. Julkiseen metodiin ei
lisätä async-wrapperia, joka vaihtaisi palautetun Promisen identiteetin.
Aktiivisen ja viimeksi palautuneen hyväksytyn kutsun tietueet säilyvät erikseen.
Hylätty rinnakkainen yritys saa oman tietueensa korvaamatta aktiivisen kutsun
viimeisintä tietoa. observeCurrentCall palauttaa vain hetkellisen sidotun
snapshotin; resurssiomistaja sitoo alikutsunsa sen alkuperäisellä Promisella.

Operationsin binding ratkaistaan kerran joko alkuperäiseen task.result/settled-
pariin tai no-task-tietueeseen. no-task kertoo vain task-kahvan puuttumisesta;
mahdollinen OS-prosessin synty arvioidaan alkuperäisestä virheestä ja muusta
näytöstä. Ennen taskin sidontaa pyydetty havainto odottaa saman kutsun päätöstä.
Aiemman kutsun settlementiä ei lainata uudelle epäonnistuneelle kutsulle.

Resurssiomistaja ottaa native-havaintokahvan heti dispatchissa ennen odotuksia.
Sen binding sisältää saman Work-tietueen alkuperäisen verify-lupauksen,
operaatiolupauksen ja native-havainnon. Puuttuva operation merkitsee tämän
kutsun tekemätöntä operaatiota. unavailable erottaa tilanteen, jossa operaatio
aloitettiin mutta havaintokahvan haku epäonnistui. Alkuperäinen operaatio säilyy
omistettuna tässäkin virheessä. Verify-vaiheen havainto voi jatkua kutsun A
valmistuttua ja B:n alettua; kahva pysyy sidottuna A:han.

Outcome säilyttää alkuperäisen fulfilled/rejected-havainnon ja hylkäysobjektin.
Promise.allSettled-käyttäjä säilyttää kunkin alkuperäisen lupauksen tuloslajin;
hylkäystä ei muuteta onnistumiseksi. Mahdollinen nykyinen omistajastatus on
erillinen havainto ja eri asia kuin vanhan kutsun sulkutodiste. Havaitseminen ei
käynnistä, peruuta tai nollaa työtä eikä muuta sen onnistumisdeadlinea.
Diagnostiikan erillisen odotusrajan valitsee kutsuja.

Uuden havaintorajapinnan lähde-, tyyppi- ja raakanäyttökatselmus läpäisivät.
Kymmenen uutta regressiota sekä kaikki aiemmat tapaukset läpäisivät: yhteensä
180/180, 11 tiedostoa. Mukana ovat Promisen identiteetti, vieras Promise,
havainto ennen taskin sidontaa, aiemman settlementin lainaamisen esto,
alkuperäinen settlement-hylkäys, epävarma no-task, A/B-kilpailu,
verify ilman dispatchia, unavailable-havainto sekä reentrant verifieri.
Tämä 180 tapauksen sarja ei yksin lisää todellista resurssi/Worker-, Host-
tai oletuskoostamisnäyttöä.

## Valmistelun yhteinen elinkaariportti (kesken)

Sama ulkoa hyväksytty paketti antaa nyt myös sisäisen staging-kyvykkyyden.
Lataus ja launch-varmennus pysyvät vain lukevina. Erillinen stageWorker
valmistelee täsmälleen saman kahdeksan tiedoston kohortin; se ei käynnistä
prosessia, myönnä ACL-oikeuksia tai poista jälkiä. Tehdas johtaa reservationin
kerran sidotun controlFile-hakemistosta. prepareWorker-kutsulle annetaan vain
alkuperäinen omistajamääräaika ja peruutussignaali, ei uutta kohdepolkua.

Valmistelu ja natiivikutsut jakavat saman aktiivisen työn portin sekä pysyvän
epäonnistumistilan. Stagingin alkuperäinen raja on pienempi omistajarajasta ja
valmistelun alusta + 30 sekuntia. Apurikäynnistyksen 20 sekunnin katto säilyy
erillisenä. Hrtime luetaan ennen performance-arvoa. Sama kerran muodostettu
bigint-raja välitetään paketin stagingiin; siellä ei muodosteta uutta aikaa.
Sitä ja peruutusta tarkistetaan ennen jokaista mkdir-/copyFile_EXCL-kutsua,
jokaisen staging-vaiheen awaitin jälkeen ja ennen onnistumisen luovutusta.

Julkinen tulos voi epäonnistua ennen kesken olevan kopion päättymistä.
Alkuperäinen staging-lupaus ja havaintoketju säilyvät aktiivisessa työssä.
Myöhäinen tulos ei aloita seuraavaa kopiota tai natiivikutsua. Osittainen
puu säilytetään ja omistaja jää epäonnistuneeksi; uutta omistajaa, resettiä
tai legacy-varareittiä ei käytetä. Vanha runtime-rajapinta säilyttää aiemman
signal-/timeout-politiikkansa ja käyttää samaa tiedostovalmistelun toteutusta.

Kutsukohtaisen bindingin kind erottaa native- ja stage-kutsun. Stage sisältää
alkuperäisen staging-Promisen, ei keksittyä native-settled- tai sulkutodistetta.
Sen exitVerified kertoo vain, ettei tämä tiedostovalmistelu käynnistä prosessia;
se ei todista keskeneräisen tiedostotyön päättymistä tai aiempien lasten sulkua.
StagingPending/pending säilyvät alkuperäisen I/O:n päättymiseen. Outcome pitää
alkuperäisen tulosrajan virheen erillään myöhäisen tiedostotyön tuloksesta.

Staging-lähdeosan, täsmällisen koereseptin ja raakatulosten riippumaton
katselmus sekä desktop-build ja testityypitys läpäisivät. Yhteensä 199/199
tapausta läpäisi ilman ohituksia tai uusintaa: aiemmat 180 ja uudet 11
omistajan, yksi tehtaan ja seitsemän tiedostovalmistelun tapausta.
Tiedostotestit käyttivät omaa koepuutaan ja sovellusprosessien käynnistys
oli estetty. Ne eivät ajaneet oikeaa staging–Host–Worker-ketjua tai hyväksy
sen käyttöjärjestelmärajoja. Tämä on AZ-vaiheen rajaus; myöhemmät
Host-tulokset erotetaan [BF:n näytössä](#node-isännän-rajattu-testinäyttö).

Hostin liitos vaatii alkuperäisen avausrajan ennen hakemiston valmistelua,
saman rajan koko avausketjuun ja consume-toiminnolle omistajan
autentikointirajan ennen publication-odotusta. Nämä rajat on kytketty
pakolliseen loader-porttiin. PrivateDirectoryn suora käynnistys korvattiin
saman omistajan directory-roolilla; alkuperäisten töiden omistus säilyy.
Terveen omistajan normaali cleanup voi käyttää alkuperäistä 30 sekunnin rajaa;
epäonnistunut tai keskeneräinen työ estää uudet tiedosto-/natiivimutaatiot.
Backendin detach/revoke ja listenerin sulku etenevät siitä riippumatta.
Uusi erillinen cleanup-omistaja tai resetti ei ole varareitti.

## Hostin pakollinen resurssilataaja (kesken)

Sama NativeDevelopmentHost käyttää nyt pakollista luotettua loader-porttia.
Tuotantoon ei lisätä valinnaista legacy-lifecycle-hookia tai suorien apurien
varareittiä. Constructor varaa backendin elinikäisen omistajuuden ennen
lataajacallbackeja. setEnabled(true, openingDeadline) tarvitsee alkuperäisen
absoluuttisen performance-rajan ennen hakemiston valmistelua. Alkuperäinen
opening-Promise julkaistaan ennen callbackeja ja säilyy erillään määräajassa
päättyvästä julkisesta tuloksesta. Myöhäinen työ ei aloita seuraavaa vaihetta.

Pakettiin sidottu factory palauttaa saman muuttuvan resurssiomistajan ja
muuttumattoman controlFile-metadatan. Koko owner-instanssia ei jäädytetä,
eikä metodeihin lisätä Promise-identiteetin vaihtavia async-kääreitä.
Host tarkistaa controlFilen täsmäosuman ennen ensimmäistä operaatiota.
Operaatioihin ei anneta erillisiä tiedostopolkuja. Loader tarkistaa nyt olemassa olevan välittömän vanhemman ja sallii vain
puuttuvan kontrollilehden. Host tarkistaa sidonnan ja kutsuu saman omistajan
prepareDirectory-operaatiota ennen varausta tai muita operaatioita.
Hakemistovalmistelun jatkomuutos kuuluu hyväksyttyyn rajattuun 306 tapauksen
BC-sarjaan. Sen mock-rajaus ei yksin hyväksy oikeaa grant-/ACL- tai
Worker–Host-ketjua; myöhemmät tulokset on erotettu
[BF:n näytössä](#node-isännän-rajattu-testinäyttö).

NativeDevelopmentResourceCall säilyttää kutsun alkuperäisen Promisen ja sen
result-havainnot ennen observeCall-hakua. Host lisää tietueen omaan elinkaareen
ennen hakucallbackia. Myös falsy-poikkeama jää havaintopuutteeksi. Tietue
odottaa alkuperäistä verify-/stage-/operaatiotyötä sekä sidottuja native-
result/settled-havaintoja. Promise.allSettled ei muuta hylkäyksiä onnistumiseksi;
alkuperäiset tuloslajit ja syyobjektit säilyvät. Vanhan kutsun settlementiä
tai nykyistä statuslast-arvoa ei lainata uuden kutsun sulkutodisteeksi.

Sulku pitää alkuperäisen close-Promisen ja 30 sekunnin rajan. Backendin
irrotus/mitätöinti ja listenerin sulku käynnistyvät odottamatta resurssityötä.
Consume/release tarvitsee täsmäävän sidonnan, päättyneet alkuperäiset työt,
terveen omistajan sekä positiiviset alkuperäiset sulkuhavainnot. Myös täyttynyt
mutta uncertain-settlement estää mutaation. Julkinen myöhäinen sulkutulos ei
korvaa aiempaa aikakatkaisua. Havainnointi ei käynnistä uutta aktoria tai
pidennä onnistumisen määräaikaa.

Testisiirto säilyttää vanhojen 44 tapausten vastuut: 38 controller-tapausta
siirtyy uuteen synteettiseen resurssiporttiin ja kuusi helper-paketin oraakkelia
helperin omiin testeihin. Controller-fixture käyttää oikeita Node-tiedostoja,
paikallisia putkia ja backend-palveluja mutta synteettisiä resurssi-/sulku-
havaintoja. ACL-valmistelu on fixture-mkdir, eikä sovellusprosessia käynnistetä.
Se ei ole C++-julkaisun, Windowsin oikeuksien tai todellisen Workerin näyttöä.
Fixturen alkuperäiset työt odotetaan ennen oman koepuun poistoa.
Ennen directory-valmistelua ajettu suljettu 93 tapauksen valinta sisältää 50 controller-, 12 ledger-,
22 factory- ja yhdeksän helper-tapausta. Desktop-build, testityypitys ja
kaikki 93 tapausta läpäisivät yhden rajatun ajon ilman ohituksia tai uusintoja.
Riippumaton lähde- ja raakakuittien katselmus hyväksyi tämän rajatun näytön.
BB:n 93 tapauksen vaiheessa tyypitykseen sisältyvä oikea broker-fixture jäi
ajamatta. Prosessikuitit eivät
vahvista jälkeläisten sulkua, eikä controller-koe hyväksy Windowsin eristystä.

BB-vaiheessa broker-fixturen rajapinta siirrettiin uuteen loaderiin ilman
uuden oikean ajon hyväksyntää. BF:n suoran import-version kaksi myöhempää
Host-ajoa sekä nykyisen lazy-import-version erillinen näyttöraja ovat
[BF:n yhteenvedossa](#node-isännän-rajattu-testinäyttö). Jokainen oikea tapaus tarvitsee tuoreen Main-
prosessin sekä ajoreseptin erikseen hyväksymän launch-binding.json-syötteen;
THREC001-lupaa tai compiled-pinneja ei päätellä paketin omasta ilmoituksesta.
Vanhaa reseptiä ei käytetä omistajan nollaamiseen. Suoran
securePrivateDirectory-kutsun korvaava saman valvojan directory-rooli on nyt
lähteessä ja hyväksytyssä rajatussa BC:n 306 tapauksen sarjassa. Tässä vaiheessa
todellinen grant-/ACL-käyttäytyminen ja Worker–Host-ketju jäivät avoimiksi;
myöhemmät BD-/BE-/BF-kokeet eivät laajenna tämän mock-sarjan todistusvoimaa.
Mock-näyttö ei ole oikean Host-kokeen, OS-eristyksen tai oletuskoostamisen hyväksyntä.

Hakemistovalmistelu käyttää kiinteää järjestelmän PowerShell-polkua ja
pinneihin kuuluvaa kiinteää script/grant-moduulia. PowerShell on erillinen
luotettu Windows-resurssi; kolme natiiviohjelmapinniä eivät hyväksy sitä.
Ainoa operaatiopyyntö on directory, ilman polkua, ohjelmaa tai caller-inputia.
Sovitin muodostaa THDIR001-kehyksen, ja sama valvoja luovuttaa sen vain
alkuperäisen määräajan/CAS-portin kautta. Script odottaa täsmälleen kahdeksan
raakatavua ja EOF:n ennen ensimmäistä tarkoituksellista tiedostomutaatiota.
Kuitti kelpaa vasta alkuperäisen lapsen close- ja Workerin exit0-havaintojen jälkeen.

Vain kontrollilehti saa puuttua. Script tarkistaa polkuketjun uudelleen grantin
jälkeen ja vaatii välittömälle vanhemmalle valmiin Mainin omistaman, periytymisen
sulkevan owner/System-DACL:n. Samat ehdot tarkistetaan olemassa olevalta lehdeltä
ennen luontikutsua ja lopputilasta ennen kuittia. Väärää omistajaa tai DACL:ää
ei korjata. Luotettu Main-koostaminen vastaa myös vanhemman ja olemassa olevien
esi-isien suojaamisesta muiden käyttäjien vaihdoilta: Node/.NET-polkuhavainnot
eivät ole native-handleen sidottu identiteettilukko. Saman käyttäjän/adminin
sovellus- tai polkumuutoksia ei rajata tällä mekanismilla. Täysi grant voi jo
sallia vaikutuksen; sen jälkeinen abortti säilyttää authorityCommitted-tiedon
eikä poista hakemistoa tai käynnistä uutta yritystä.

Erillinen aito script-koe läpäisi 19 tapausta: kaksi luonnollista exit0-
onnistumista, 16 odotettua luonnollista exit1-torjuntaa ja yksi suunniteltu
no-EOF-katkaisu. Kaikkien lapsien alkuperäinen päättyminen ja putkilukujen
valmistuminen sekä 22 ulomman vaiheen exit0 havaittiin. Riippumaton lähde- ja
raakakuittien katselmus hyväksyi rajatun näytön. Node varmisti fixturejen
identiteetit/sisällöt ja junction-kohteiden canaryt ennen vain linkkien poistoa.

Koe käyttää samaa pinneihin sidottua script/grant-arvoa ja kuuden compiled-
moduulin sulkeumaa. Windowsin Framework-stdin-kirjoittajan alkutavujen on oltava
tyhjät ennen Startia ja palautuneessa writerissä; konsolin asetuksia ei muuteta.
Peruste näkyy Microsoftin [Process-toteutuksessa](https://raw.githubusercontent.com/microsoft/referencesource/main/System/services/monitoring/system/diagnosticts/Process.cs)
ja [StreamWriter-toteutuksessa](https://raw.githubusercontent.com/microsoft/referencesource/main/mscorlib/system/io/streamwriter.cs). Synkronisen Start/Write/Flush/EOF-vaiheen myöhästyminen jää pysyväksi
virheeksi. Writerillä on yksi sulkija. No-EOF-kokeen tarkoituksellinen omistetun
lapsen tappaminen erotetaan luonnollisista suluista, eikä yksittäinen
puuttumisnäyte todista scriptin lukukohdan saavuttamista. Junctionien kohteiden
sisältö ja oikeudet tarkistetaan ennen vain itse linkkien poistamista.
Väärä omistaja, laaja ACL-matriisi ja vihamielinen polunvaihtokilpailu jäävät
rajauksen ulkopuolelle; nämä tapaukset eivät hyväksy Worker/Host-ketjua.

Node-isännän testiapu säilyttää nyt alkuperäiset loader-, factory-, kutsu-,
Worker- ja tiedosto-I/O-havainnot. Delegaatti palauttaa täsmälleen alkuperäisen
Promisen ja lisää kutsun elinikäiseen luetteloon ennen havaintokahvan hakua.
Fyysinen sulkeutuminen erotetaan alkuperäisestä onnistumisesta: myöhäinen
child-close/Worker-exit ei korota alkuperäistä exitVerified-epävarmuutta.
Stage vaatii alkuperäisen tiedosto-I/O:n valmistumisen ilman prosessiväitettä.

Ennen käynnistyksiä asennettu elävä kahva säilyttää keskeneräisen työn
ulomman prosessipuuomistajan saavutettavana. Näissä erillisissä tapauksissa
framework-aikaraja on nolla; alkuperäiset operaatio- ja kuuden sekunnin
sulkuhavainnon rajat säilyvät. Epäonnistunut ensisijainen kuitti jää
muuttumattomaksi ja myöhäinen havainto erilliseksi. Myös Main-tracen
historiallinen uncertain-lippu estää konservatiivisesti kahvan vapautuksen;
kyse ei tällöin ole vain luetteloitujen lasten fyysisen sulun odottamisesta.

Generic-bypass-hakemiston valmistelee rajattu parent. Hostin oma control on
alussa poissa, ja sen valmistelee sama tuotantoresurssiomistaja. Mainin
negatiiviset kontrollit säilyvät erillään Worker-kutsuista.
Completion-uusinta käyttää samaa jo ladattua omistajaa.

### Node-isännän rajattu testinäyttö

Havaintoavun 11 ja ledgerin 12 synteettistä tapausta läpäisivät samassa
rajatussa 23 tapauksen ajossa. Sama 23 tapauksen valinta läpäisi myös
tavallisen root-konfiguraation kautta: havaintoavun täsmällinen testipolku on
mukana sen include-valinnassa. Tämä ei ole koko root-sarjan ajo eikä uusi
yksilöllinen testijoukko. Desktop-build ja kohdistettu testityypitys
läpäisivät. Näyttö todentaa alkuperäisten lupausten ja havaintojen käsittelyä.

Suoraa käännetyn factoryn runtime-tuontia käyttävä lähdeversio läpäisi kaksi
erillistä oikeaa Host-tapausta, kumpikin tuoreessa Main-prosessissa:

- MCP-tilakierros ja Main-STOP: yhdeksän native-kutsua, yksi stage-I/O sekä
  saman completionin uusinta samalla omistajalla. Mainin yhdeksän erillistä
  kontrolli-/broker-lasta sulkeutuivat: seitsemän exit0:aan ja kaksi odotettua
  hylkäystä exit1:een.
- Liittymättömän, sinetöidyn istunnon Host-disable: kahdeksan native-kutsua ja
  yksi stage-I/O. Suoria Main-lapsia tai broker-asiakasta ei käynnistetty.

Kaikista 17 native-kutsusta havaittiin alkuperäiset fulfilled-tulokset,
child-close ja Worker-exit0. Molempien omistaja jäi terveeksi; stage-I/O
valmistui erikseen. Alkuperäiset SDK-/broker-/STOP-/stdin-/journal-/release-
oraakkelit säilyivät. Molemmat testiprosessit päättyivät luonnollisesti
exit0:aan ilman myöhäistä kuittia, pakkosulkua tai uusintaa. Release-pyynnön
hetkellä broker-close-havainto sai olla false; se ei yksin todista natiivin
lease-odotuksen toteutumista. Lopullinen broker-exit0 ja vapautuksen omat
sulkuhavainnot vaadittiin.

Nykyinen fixture lataa saman kiinteän compiled-URLin vasta eksplisiittisen
koekäynnistyksen sisällä. Alkuperäinen loader-Promise omistaa myös importin;
deadline/abort tarkistetaan ennen sitä ja sen jälkeen. Tavalliseen keräilyyn
ei lisätä desktop-dist-riippuvuutta, source-fallbackia, valittavaa URLia tai
uutta factorya. Tämä viimeinen fixtureversio läpäisi tyypityksen, erillisen
kopion keräilyn ilman desktop-distiä (kaksi tarkoituksella skipattua tapausta,
nolla suoritettua) sekä fixed compiled import-only -tarkistuksen ilman
factoryn kutsumista. Edellä mainitut kaksi oikeaa Host-ajoa ovat aiemman
suoran import-version näyttöä; nykyistä lazy-import-versiota ei ajettu
uudelleen oikeana Host-ketjuna.

Näyttö käyttää synteettistä backendia. Se ei hyväksy oletus-Electron-
koostamista, rearm/recovery-kokonaisuutta, riippumatonta kaikkien OS-
jälkeläisten tai profiilivaraston inventointia eikä koko CPU/GPU/FMI-
minimipakettia. Aiemmat epäonnistumiset puuttuvine historiallisine
sulkuhavaintoineen säilyvät. Karanteenin apureita ei ajettu tai palautettu,
eikä uusia natiiveja tarkistusohjelmia tehty.

## Pakettiin sidotun resurssipolun rajattu ajonäyttö

Uudempi kolmen kutsun koe läpäisi saman tuotantotehtaan ja resurssiomistajan
kautta directory → identity → recover -ketjun. Kaikki 18 alkuperäistä havaintoa
valmistuivat: kolme lapsisulun ja kolme Worker-exit0:n kuittia, valtuusjärjestys
true / false / true. Omistaja jäi terveeksi ja valmistelluksi ilman pending-
työtä. Node varmisti puuttuneen kontrollilehden luonnin, fyysisen polun sekä
vanhemman identiteetin säilymisen. Erilliseen hash-/allekirjoitushyväksyntään
sidottu PowerShell ja lopullinen owner/System-ACL:n vastaavuus tarkistettiin.
Native recover poisti synteettisen pending-fixturen. Molemmat ulommat Node-
vaiheet päättyivät exit0:aan ilman pakkosulkua, stderr-tulostetta tai uusintaa.
Riippumaton lähde- ja raakakuittien katselmus hyväksyi rajatun näytön.

75 sekuntia on tämän uuden kolmen kutsun koefikstuuren alkuperäinen kokonaisraja;
se ei muuta Mainin avauspolitiikkaa tai aiempien kokeiden tulkintaa. Valmistelun
10 s ja yksittäisen kutsun enintään 20 s rajat käyttävät jäljellä olevaa
alkuperäistä aikaa. Epävarman työn aikana koordinaattori säilyy ulomman
prosessipuun omistajan saavutettavana; myöhäinen sulku ei korjaa vanhaa tulosta.
BE:n kolmen kutsun koe ei yksin osoita Hostia tai staging–Host-yhteisajoa;
myöhempi suoran import-version Host-näyttö on erotettu
[BF:n yhteenvedossa](#node-isännän-rajattu-testinäyttö). Electron, oletuskoostaminen,
aidot virhepolut ja riippumaton kaikkien jälkeläisten inventointi jäävät avoimiksi.

Alla oleva kahden kutsun näyttö on aiemmasta AY-versiosta omine pinneineen.
Sitä ei tulkita uuden directory-roolin näytöksi.

Erillinen suora Node-koe käytti oikeaa käännettyä resurssitehdasta,
semanttista Operations-sovitinta ja kiinteää Worker-käynnistintä. Riippumaton
katselmus tarkisti ennen ajoa lähteet, 23 käännetyn moduulin import-ketjun,
pakettiviennit, työtilalinkit ja täsmällisen ajoreseptin. Sama ulkoa hyväksytty
runtime-descriptor sitoi verifierin, kolme natiiviohjelmaa ja THREC001-luvan.

Yksi hyväksytty ajo suoritti identityn ja recoverin sarjassa. Alkuperäinen
55 sekunnin kokonaisraja rajasi valmistelun ja kumpaisenkin kutsun enintään
20 sekuntiin; yksittäinen vaihe ei aloittanut kokonaisbudjettia uudelleen.
Alkuperäisen tuloslupauksen havainnot asennettiin ennen kutsukohtaisen
havaintokahvan hakua, ja molemmat alkuperäiset työt säilyivät loppuhavainnossa.
Kumpikin kutsu palautti kaikki kuusi sidottua havaintoa onnistuneina:
verify, operaatio, resurssin ja semanttisen sovittimen outcome sekä natiivin
result ja settled. Molempien lasten todellinen close ja Worker-exit0
havaittiin. Valtuus oli identitylle false ja recoverille true.

Vasta identityn jälkeen luotu synteettinen pending-fixture poistui natiivin
recover-operaatiossa. Lopullista bootstrap-tiedostoa, keskeneräistä työtä,
verifiointia tai epävarmaa omistajatilaa ei jäänyt. Node ja ulompi ajuri
päättyivät exit0:aan ilman pakotettua sulkua tai uusintaa. Lähde- ja
linkkipinnit tarkistettiin ennen ajoa ja sen jälkeen. Raakakuitit sekä
konekohtaiset mittaukset säilyvät paikallisina. Riippumaton jälkitarkastus
hyväksyi tämän rajatun onnistumispolun.

Koe ei käyttänyt vanhoja suoria suoritusmetodeja eikä erillisiä natiiveja
tarkistusbinäärejä. Se ei käynnistänyt broker-operaatiota, MCP-workeria,
mallia, GPU:ta, sää-APIa tai Electronia. Myöhäiskuitteja ei syntynyt, joten
uusia todellisia virhe-/myöhästymispolkuja ei hyväksytty. AY-vaiheessa Hostin
kytkentää ei ollut tehty; myöhempi rajattu näyttö on
[BF:n yhteenvedossa](#node-isännän-rajattu-testinäyttö). Oletuspolku ja koko
minimipaketin CPU/GPU/FMI-, tiedosto-, virhe- ja sulkukokeet ovat kesken. Aiempien epäonnistuneiden ajojen tuntematon
sulku ja viiveen syy säilyvät avoimina.

## Integraation portit ja näyttö

1. Yksi oikean Windows Node worker_threads -säikeen koe varmisti
   process.hrtime.bigint()-havainnon parentin ennen/jälkeen-havaintojen väliin,
   saman prosessin ja normaalin exit0:n ilman pakotettua lopetusta tai tulosteita.
   Node-koe ei yksin hyväksy Electronin paketoitua käynnistystä.
2. Oikea adapteri käyttää vain kiinteää compiled worker-entryä ja sen
   tarkistettua import-ketjua, tyhjää execArgv:tä ja suodatettua ympäristöä.
   Source-, eval- tai vapaata ohjelmapolkua käyttävää varareittiä ei tehdä.
3. Recoverin ei-tyhjän kehyksen lähdemuutos on tehty natiiviin, suoraan
   adapteriin ja valvojaan. Main muodostaa kiinteät THREC001-tavut itse vasta
   omaan input-kopioonsa; julkinen recover-pyyntö ei saa vapaata inputia.
   Main vapauttaa kopion vasta started-viestin jälkeen, ja atominen portti
   vaaditaan ennen sen lähettämistä. Uusi native vaatii täsmälleen 8 tavua ja
   EOF:n; lukukatto on 9 tavua. Tyhjä tai osittainen broken pipe ei kelpaa.
   Kokonaisen kehyksen jälkeinen broken pipe voi kuitenkin olla EOF: jo
   toimitettua valtuutta ei tällöin peruta. Kehys ei ole autentikointisalaisuus.
   Natiivimuutoksen sisältävä käännetty paketti läpäisi alla kuvatun
   13 tapauksen CLI-kokeen. Vanha ajopaketti hyväksyy yhä tyhjän EOF:n:
   käyttöönotto tarvitsee nimenomaan uuden muutoksen sisältävän pakettipinnin.
4. Oikean lapsen myöhäinen käynnistys, peruutus ja sulku sekä workerin
   virhepolut hyväksytään erikseen. Kaksi aiempaa käynnistysviiveeseen
   pysähtynyttä sovelluskoetta säilyvät epäonnistuneina.

## Node-koesarjan omistus ja protokollan ajonäyttö

Yhteinen tests/support/mcp/native-recovery-probe.ts säilyttää aktiivisen
case-kontekstin, alkuperäisen operaatiolupauksen, keskeneräiset tiedostotyöt ja
palautuneen lapsiprosessikahvan. Tiedostovaiheilla on nimetyt, rajatut
monotonic-vaihemerkit ja järjestysnumerot. Pelkkä testikehyksen timeout ei
peruuta sen alla jatkavaa työtä. Oma alkuperäinen raja estää jatkon ja
keskeneräinen työ säilyttää omistajuuden epävarmuuden.

afterAll sulkee uuden työn portin ensin, pysäyttää tarvittaessa vain jo
omistetun lapsen ja havainnoi aiempia töitä rajatusti. Erillinen, enintään
sekunnin loppuhavainto ja diagnoosikuitin odotus eivät pidennä operaation
onnistumisrajaa. Teardown-kuitti erottaa alkuperäisen virheen myöhemmästä
sulusta. Puuttuva kuitti on puuttuvaa näyttöä.

Samaa omistajaa käyttävät seitsemän determinististä testiä läpäisivät:
keskeneräinen tiedostotyö, myöhäinen käynnistyspaluu ilman timer-dispatchia,
synkroninen stdin-virhe, teardownin aikana saapuva sulku, onnistuvien
tapausten sarja, saman kellolukeman tapahtumajärjestys ja myöhäinen
pakettitarkistus. Ne eivät käynnistä oikeaa lapsiprosessia.

Instrumentoitu Windows-koe kutsui vain varmennetun uuden tuotantopaketin
main-bootstrap.exe --recover -toimintoa omalla synteettisellä aineistolla.
Kaikki 13 tapausta ja integraatiotyypit läpäisivät:

- 0–7 tavun prefiksit, väärä kahdeksan tavun kehys ja ylimääräinen tavu
  hylättiin. Pending-tavut tarkistettiin säilyneiksi lapsen sulkeutumisen
  jälkeen ennen testin omaa poistoa.
- Täydellinen kehys ilman EOF:ää päättyi alkuperäiseen natiiviwatchdogiin,
  koodiin 70, tiedoston säilyessä.
- Täydellinen kehys ja EOF sekä kehyksen jälkeinen putken sulku hyväksyttiin.
  Natiivi poisti pending-tiedoston; testin omaa poistoa ei kutsuttu.
  Jo toimitetun kehyksen jälkeinen sulku ei siten ole peruutus.

Kaikkien 13 lapsen todellinen close havaittiin ilman kill-pyyntöjä.
Loppukuitti sisälsi 312 järjestettyä tapahtumaa, eikä alkuperäistä virhettä,
keskeneräistä työtä tai ylivuotoa jäänyt. Molemmat ajoprosessit päättyivät
todelliseen exit0:aan. Brokeria, MCP-workeria, mallia, säätä tai Electronia
ei ajettu; tämä ei hyväksy niiden oikeusrajoja.

Ensimmäinen, ennen omistajuuskorjausta tehty recover-CLI-sarja säilyy
epäonnistuneena. Sen ensimmäinen tapaus jäi testin 10 sekunnin aikarajaan ja
12 myöhempää estettiin. Case- tai process-kuittia ei syntynyt. Säilynyt
8-tavuinen pending-fixture tai myöhempi lukuhavainto ilman käynnissä olevaa
apuria ei todista kirjoitus-awaitin valmistumista, apurin käynnistymistä,
syötteen toimittamista tai historiallista sulkua. Ne ja viiveen syy pysyvät
tuntemattomina; uusi läpäisy ei muuta niitä tunnetuiksi.

AQ/AR/AS/AT-osajulkaisun historiallisessa AT-valmistelussa Host-reseptin
lähdevalinta päivitettiin 103 tapaukseen
(44 Host + 42 connection + 12 wire + 2 development-host + 3 helper).
Bootstrapin lähdelista, sitä vastaava Hostin receipt-ehto ja Hostin omat
pinnit sisältävät uuden recover-grantin; Host sitoo myös release-policy-lähteen.
Tätä vanhaa 103 tapauksen reseptiä ei hyväksytä nykyisten rajapintojen ajoksi.
Koko reseptiä tai vanhan bootstrap-proben rakentamista ja ajoa ei tehty AT-valmistelussa. Aiempi ajamaton 97 tapauksen Host-valinta ja
historiallinen 47 tapauksen bootstrap-näyttö eivät ole uuden protokollapaketin
nykyhyväksyntä.

Tämä ei hyväksy MCP:n uudelleenavausta, kaatumispalautusta, profiilitallennuksen
täydellistä poissaoloa tai koko FMI-/CPU-/GPU-minimipakettia. Liittyneen
sessionin näyttörajan omistaa [clean-vapautuksen sopimus](mcp-clean-release.md).
