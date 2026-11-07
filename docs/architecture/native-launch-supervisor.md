# Natiiviapurien käynnistysvalvoja

Tila: Main-puolen lähde- ja mocktestipohja. Desktop-build, testityypit ja
56 kohdennettua mocktapausta ovat läpäisseet (7 atomista porttia,
29 valvojaa ja 20 suoran bootstrap-kuljetuksen tapausta). Oikean Node-säikeen
kellokoe sekä uuden recover-kehyksen 13 tapauksen tuotanto-CLI-koe läpäisivät.
Koesarjan yhteisen omistajan seitsemän mockregressiota läpäisivät.
Oikea launch-worker ja sovellukseen kytkentä ovat tekemättä.
Tämä dokumentti omistaa valvojan sopimuksen. Käyttöjärjestelmän oikeudet
kuuluvat [turvallisuussuunnitelmaan](security-and-permissions-plan.md).

## Vastuut ja tulokset

Valvoja on Mainin luotettua koodia, ei uusi eristysraja. Tuleva
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

Määräaika muodostetaan kerran ennen workerin luontia. Pohjan enimmäisrajat
ovat identitylle neljä ja muille apuritoiminnoille kuusi sekuntia.
Mainin alkuperäinen 30 sekunnin sulku ja natiivin oma viiden sekunnin
watchdog stdin-odotuksineen eivät ala uudelleen. Mahdollinen pidempi
avausvaiheen kokonaisbudjetti tarvitsee erillisen sopimuksen.

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
