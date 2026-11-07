# Natiiviapurien käynnistysvalvoja

Tila: Main-valvoja, oikean säikeen sovitin ja worker-core ovat lähteessä.
Desktop-build, testityypit ja 180 tapausta ovat läpäisseet: 154 determinististä
mocktapausta ja 26 tiedostoresurssitapausta, yhteensä 11 tiedostoa.
Mukana ovat gate/aikabudjetti 10, valvoja 29, worker-core 22, config 7,
worker-loader 6, myöhäinen havainto 7, identity-codec 7, semanttinen sovitin 23,
resurssiomistaja 23, resurssitehdas 20 ja tiedostoresurssit 26.
Suljettu valinta on tests/support/mcp/native-launch-resources-vitest.config.mjs.
Aiemmat 170/106/81/70/56 sarjat ovat osin samoja testejä, eikä niitä summata.
56 sisälsi erilliset 20 suoran bootstrapin tapausta.

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
identity-, bootstrap- tai session-operaatioille.

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

Mainin alkuperäinen 30 sekunnin sulku ja natiivin oma viiden sekunnin
watchdog stdin-odotuksineen säilyvät. Myöhempi composition välittää sulun
jäljellä olevan alkuperäisen ajan; uusi 20 sekunnin allowance ei jatka sitä.
Timeout tai cancel ennen commitia estää syötteen. Commitin jälkeen
mahdollinen vaikutus ja epävarmuus säilyvät myös myöhäisen sulkuhavainnon jälkeen.

## Kiinteä worker ja rajattu ajonäyttö

Sovitin lataa vain compiled `native-launch-worker.js`-entryn. Sen todellinen
runtime-ketju on core → config, gate ja recovery-grant; Main-puoli sitoo lisäksi
portin, valvojan sekä validation/public-riippuvuuden. Worker käyttää tyhjää
execArgv:tä, argv:tä ja ympäristöä. Lapselle välitetään vain erikseen hyväksytyt
neljä ympäristöavainta ja kiinteän paketin yhdeksän operaatiomuotoa.

Yksi loader-kutsu varaa Main-moduulin elinkaaren ennen validointia tai I/O:ta.
Lähde-/eval-entryä, omistajan resettiä tai Worker.terminate/unref-varareittiä
ei ole. Kolmen natiiviohjelman ja viiden worker-tiedoston koko/hash tarkistetaan
riippumattomasti hyväksytyistä pinneistä. Saman käyttäjän tai ylläpitäjän
sovelluskoodin muutos on luottamusrajan sisällä; tarkistus ei ole Windowsin
kirjoittamisen/poiston estävä ohjelmakahva. Worker on luotettua sovelluskoodia,
ei käyttöjärjestelmän eristysraja.

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

NativeLaunchOperations on vielä kytkemätön lähdeosa. Sen kutsuissa on vain
identity, bootstrap- tai session-operaatio, tarvittaessa oma 96 tavun descriptor,
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
Main/Host/resurssikerroksen oletusliitosta ei ole tehty.

## Pakettiin sidottu resurssiomistaja (kesken)

Uusi, vielä kytkemätön tehdas muodostaa verifierin ja Worker/Operations-omistajan
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

Jokainen resurssikutsu varaa omistajan synkronisesti ja kopioi descriptorin
ennen verifierin awaitia. Kellomuunnos lukee hrtime-arvon ensin ja performance-
arvon vasta sen jälkeen; jäljellä oleva aika pyöristetään alaspäin ja rajataan
20 sekuntiin kerran ennen I/O:ta. Sama bigint-raja kulkee Operationsille.
Myöhäinen verify-tulos tai abortti ei aloita natiividispatchia. Alkuperäinen
verify-lupaus säilyy omistettuna myös erillisen tulosrajan jälkeen. Natiivivaiheen
määräajasta ja result/settled-kuiteista vastaa edelleen aito Operations/Supervisor.

Lukuvarmennin tarkistaa alkuperäisen descriptor-pinnin, build-manifestin sekä
kolme kiinteää ohjelmaa. Se ei kutsu legacy-helpereitä tai palauta uusia
polkuvalintoja. Saman käyttäjän/ylläpitäjän luottamusraja ja native-handle-pinnin
puuttuminen säilyvät. Vanha NativeMcpRuntime palauttaa edelleen saman rajapinnan;
uusi launch-source ei altista sen suoritus- tai staging-metodeja.

Resurssiosan lähde- ja raakanäyttökatselmus, desktop-build sekä kymmenen
TS-testitiedoston tyypitys läpäisivät. Uudet 18 resurssiomistajan ja 20 tehtaan
mockia sekä laajennettu 26 tiedostoresurssin sarja läpäisivät osana 170 valintaa.
Ensimmäinen AW-putki pysähtyi testin readonly-delete-tyypitykseen ennen
koesarjaa; vain fixturetyypin korjaus edelsi uutta onnistunutta ajoa.
Hostin/defaultin käyttöönottoa ei ole tehty. Oikean resurssitehtaan kahden
apurikutsun näyttö on kuvattu erikseen alla.
Avaamisen kokonaisbudjetti on erillinen avoin valinta. Hostin alkuperäinen
30 sekunnin cleanup-raja säilyy; staging tarvitsee alkuperäisen määräajan
ennen jokaista mkdir/copy-operaatiota ja jokaisen awaitin jälkeen.

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

## Pakettiin sidotun resurssipolun rajattu ajonäyttö

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
uusia todellisia virhe-/myöhästymispolkuja ei hyväksytty. Hostin ja oletuspolun
kytkentä sekä koko minimipaketin CPU/GPU/FMI-, tiedosto-, virhe- ja
sulkukokeet ovat edelleen kesken. Aiempien epäonnistuneiden ajojen tuntematon
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

Nykyisen versionoidun Host-reseptin lähdevalinta on päivitetty 103 tapaukseen
(44 Host + 42 connection + 12 wire + 2 development-host + 3 helper).
Bootstrapin lähdelista, sitä vastaava Hostin receipt-ehto ja Hostin omat
pinnit sisältävät uuden recover-grantin; Host sitoo myös release-policy-lähteen.
Koko 103 tapauksen reseptiä tai vanhan bootstrap-proben rakentamista ja ajoa
ei tehty tässä vaiheessa. Aiempi ajamaton 97 tapauksen Host-valinta ja
historiallinen 47 tapauksen bootstrap-näyttö eivät ole uuden protokollapaketin
nykyhyväksyntä.

Tämä ei hyväksy MCP:n uudelleenavausta, kaatumispalautusta, profiilitallennuksen
täydellistä poissaoloa tai koko FMI-/CPU-/GPU-minimipakettia. Liittyneen
sessionin näyttörajan omistaa [clean-vapautuksen sopimus](mcp-clean-release.md).
