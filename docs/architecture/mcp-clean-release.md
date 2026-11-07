# Liittyneen MCP-istunnon natiivi vapautus

Tämä dokumentti omistaa `--release-clean`-operaation. Se vapauttaa onnistuneesti
suljetun BROKER_ADMITTED-sukupolven kiinteän varauksen. Käyttämättömän
READY-sessionin erillinen [pristine-vapautus](mcp-native-transport.md#pristine-vapautus-ja-todennettu-näyttö)
säilyy ennallaan. Koko eristyksen tavoitteen omistaa
[backendin ja MCP:n eristyspolku](backend-mcp-isolation.md).

## Valtuus ja tuoreet havainnot

Vapautus on pakettiin sidotun natiivibrokerin kiinteä helper-moodi. Mainin
lataaja tarkistaa brokerin uudelleen ennen jokaista kutsua. Syötteenä ovat
alkuperäiset 96 bootstrap-tavua ja EOF; renderer, malli tai MCP-työntekijä ei
valitse polkua, prosessia, Jobia tai poistokohdetta. Onnistuminen tarvitsee
oman `session-clean-released`-kuittinsa, tyhjän stderrin ja todellisen exit0:n.
Toisen release-lajin kuitti ei kelpaa.

Natiivi omistaja pitää yhteisen leasen ja alkuperäisen sessionin kahvat.
Fyysinen 1024 tavun session luetaan ja tarkistetaan kokonaisena ennen sen
sisällön tiivistämistä intenttiin. Se sitoo elävän alkuperäisen Mainin,
generationin, descriptorin digestin, worker-paketin, owner-SID:n sekä
control-, lease-, reservation- ja stage-identiteetit. Journalin pitää olla
kanoninen v2-CLEAN, ja workerin PID/FILETIME-parin sekä profile-SID:n pitää
olla täydellisiä ja sidottuja samaan kontekstiin.

Ennen intentin luontia ja jokaista poistovaihetta vaaditaan tuoreet havainnot:

- Brokerin ja workerin täsmällinen käynnistysaika ja signaloitu prosessikahva.
  Jos avaaminen ei onnistu, ainoa vaihtoehto on kokonainen prosessisnapshot,
  jossa tarkastajan oma PID esiintyy ja kirjattu PID puuttuu. PID:n uudelleenkäyttö,
  keskeneräinen luettelo tai epävarma kysely estää etenemisen.
- Generationista johdetun nimetyn Jobin varma puuttuminen. Myös olemassa
  oleva tyhjä Job estää tämän polun. Tarkistaja pyytää vain QUERY/READ_CONTROL-
  oikeuksia; se ei luo tai lopeta vierasta Jobia.
- Kiinteän worker-stagen puuttuminen ja varauksen täsmällinen sisältö.
  Jäljellä saa olla vain journal tai sen poiston jälkeen tyhjä hakemisto.

Prosessihavainnot käyttävät yhteistä `TerminationBudget`-oliota. Sen enintään
viiden sekunnin aika rajataan jo käynnissä olevaan natiivin operaation
absoluuttiseen määräaikaan. Broker, worker tai poistoprefix ei aloita uutta
viiden sekunnin jaksoa. Mainin lataaja välittää oman absoluuttisen sulkurajansa
varmistukseen, käynnistykseen ja syötteen lähettämiseen. Mainin ja natiivin
kellot ovat erillisiä; jo alkanut synkroninen Windows-kutsu ei ole tällä
keskeytettävissä. Natiivin lähteeseen on lisätty vain sharing-violationin
odotus samalla alkuperäisellä määräajalla ja elävän Mainin tarkistuksella.
Muut avausvirheet tai määräajan loppuminen hylkäävät operaation. Tämän
odotusmuutoksen 55 tapauksen Windows-kontrolli ja päivitetyn natiivipaketin
toiminnallinen koe ovat vielä ajamatta; lähdekatselmus ei hyväksy niitä ajetuiksi.

## Mainin automaattinen pyyntö ja näytön raja

Host valitsee vapautuslajin vasta descriptor-operaatioiden, yhteyksien,
backend-irrotuksen ja valtuuden mitätöinnin sekä kuuntelijan sulun jälkeen.
Täsmälleen yksi eri autentikoitu lopputulos saa pyytää clean-vapautusta;
saman olion toistuminen ei luo toista omistajaa. Jokaisen lopputuloksen pitää
olla virheetön, suljettu ja descriptorin osalta valmis. Autentikoitu omistaja
tarvitsee lisäksi CLEANin, valmiin backend-irrotuksen ja mitätöidyn valtuuden.
Autentikoimaton CLEAN-väite tai useampi eri omistaja estää molemmat lajit.
Kelvollinen kokonaisuus ilman autentikoitua omistajaa voi pyytää pristine-lajia.

Pyyntö käyttää alkuperäistä sulkurajaa. Jaettu stop-tulos ja yksi vapautuskutsu
säilyvät myös rinnakkaisessa tai uudelleen sisään tulevassa sulussa. Virhe,
epävarma apurin poistuminen tai myöhäinen valmistuminen ei muuta tulosta
onnistuneeksi, käynnistä toista release-lajia eikä avaa Hostia uudelleen.
Vain pakettiin sidottu natiivi omistaja voi suorittaa fyysisen vapautuksen.

Puhtaan valinnan 16 testiä ja Hostin 44 Windows-tapausta läpäisivät.
Host-kokeessa descriptorin julkaisu ja kulutus käyttivät aiemmin hyväksytyn
paketin muuttumattomia identity/bootstrap-apureita. Session-, worker- ja
release-portit olivat synteettisiä: release-kuittaus ei poistanut varausta.
Testiajuri päättyi exit0:aan ilman aikakatkaisua tai pakotettua lopetusta;
erillistä kaikkien jälkeläisten käyttöjärjestelmäinventointia ei tehty.
Tulos tukee Mainin valintaa ja sulkujärjestystä, mutta ei todista uuden
natiivin lease-odotuksen, fyysisen vapautuksen tai oletus-Electronin toimintaa.

## Node-ohjattu havainto ja natiivinäytön säilyttäminen

Yhteinen `tests/support/mcp/native-record-observation.ts` havainnoi
sessionin, v2-journalin sekä clean-intentin ja completionin. Luku on
rajattu tietuekokoon ja yhteen ylimääräiseen tavuun. Tyyppi, linkkimäärä,
tiedostohavainnot, header ja checksum tarkistetaan samasta avatusta
kahvasta; kahva suljetaan ennen tuloksen palauttamista. Tuotantokokeen
omat Main-/generation-/paketti-/fileID- ja kokonaisten tavujen vertailut
säilyvät. Apuri ei tee poistoja tai päätä vapautusvaltuudesta.

Havaintoapurin 17 oikean tiedoston tapausta ja 12 determinististä
I/O-mocktapausta läpäisivät yhdessä integraatiotyyppien kanssa.
Ensimmäinen tyyppitarkistus pysähtyi siirrossa käyttämättömäksi jääneeseen
muuttujaan ennen testien ajoa; korjattu ajo läpäisi 29/29. Mocknäyttö
kattaa esimerkiksi vaihtuneen tiedoston, katkenneen luvun, kokorajan ja
kahvan sulun, ei natiivin oikeusrajan hyväksyntää.

Natiivin kontrollin 55 tapausta säilyvät erillisenä kattavuusluettelona.
Havaintoapurin 29 testiä ei lasketa niiden tilalle. Deterministiset
write/flush/readback-virheet, keskeytysprefixit, tarkat Win32-jako- ja
Job-havainnot sekä sisäisen aikabudjetin mittaus tarvitsevat edelleen
vastaavan oraakkelin. Node-ohjattu tuotantokoe käyttää sovelluksen oikeita
CLI-toimintoja ja omaa synteettistä aineistoa. Testijärjestyksen ja
ajamisen rajat omistaa [testausohje](../ai/testing-rules.md#natiivikomponenttien-testien-ajaminen-nodesta).

Node-ohjatun yhdistetyn kokeen ensimmäinen yritys pysähtyi identiteettiapurin
synkroniseen käynnistysviiveeseen. Erillinen, samoilla lähteillä ja rajoilla
tehty yritys eteni julkaisun käynnistykseen, joka ylitti määräajan. Molemmat
jäivät ennen session valmistelua ja varsinaisen brokerin tai workerin ajoa;
toinen tapaus estyi ennen aloitusta. Myöhäiselle julkaisulle ei lähetetty
valtuustavuja. Omistettujen lasten myöhempi sulku havaittiin, mutta alkuperäinen
`exitVerified:false` ja jäljityksen epävarmuus säilyvät epäonnistumisena.
Näitä yrityksiä ei lasketa kahden tuotantotapauksen läpäisyksi. Käynnistysviiveen
syy on avoin; rajattu lukudiagnoosi ei yksilöinyt syytä. Alkuperäisiä
määräaikoja ja oikeusrajoja ei muutettu.

## Pysyvä intent ja poistoprefix

`native-session-clean-release.bin` on 2048 tavua ja sisältää kokonaisen
kanonisen journalin, kanonisen sessionin version 1 kentät, molempien
alkuperäisten tiedostojen identiteetit ja koko sisällön SHA-256:t sekä
intentin oman todellisen tiedostoidentiteetin. Session-version 1 varattu
nollatäyte ja checksum palautetaan tiivistetystä osasta yksikäsitteisesti;
alkuperäinen fyysinen session vaaditaan silti jokaisella uusinnalla.

Intention luonti on CREATE_NEW. Kirjoitus, flush ja täsmällinen takaisinluku
edeltävät ensimmäistä poistoa. Uusinta varmistaa kestävyyden uudelleen eikä
päättele onnistunutta flushia pelkästä eheästä tarkisteesta.

Poistojärjestys on kiinteä:

1. `native-session-reserved/broker-journal.bin`
2. tyhjä `native-session-reserved/`

Omistaja säilyttää DELETE-kahvat, estää kirjoittavat ja poistavat rinnakkaiset
avaukset sekä tarkistaa identiteetit, ACL:t ja jäljellä olevan puun.
Rekursiivista siivousta ei tehdä. Kahvan sulun jälkeinen varma poissaolo
vaaditaan ennen seuraavaa kohdetta; delete-pending tai epävarma havainto
pysäyttää etenemisen. Uusinta hyväksyy vain jo poistetun prefixin 0, 1 tai 2.
Puuttuva journal ilman kelvollista alkuperäiseen kontekstiin sidottua intenttiä
ei anna poistovaltuutta. Prosessi- ja Job-havainnot uusitaan myös journalin
poistamisen jälkeen.

`native-session-clean-released.bin` on 1024 tavun completion. Se sitoo intentin
koko SHA-256:n ja identiteetin sekä alkuperäisen kontekstin. Aiemman completionin
pitää vastata täsmälleen samasta intentistä laskettuja tavuja. Alkuperäinen
session, lease, intent ja completion säilyvät. Molempien release-lajien
merkinnät, myös vioittuneina, estävät vanhat prepare/seal/publish/admission-
polut; lajit estävät myös toisensa.

## Profiilin poistamisen näyttöraja

Nykyinen journalin tuottaja kirjaa CLEANin vasta sen jälkeen, kun
`DeleteAppContainerProfile` on palauttanut arvon, jolle `FAILED` on epätosi,
ja oma stage on poistettu. Tarkkaa HRESULTia ei tallenneta journaliin.
Siksi CLEAN kertoo tuottajan onnistuneeksi tulkitsemasta kutsusta, ei erikseen
tallennetusta S_OK:sta tai täydellisestä fyysisestä poistumisesta.
[Microsoftin API-sopimus](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-deleteappcontainerprofile)
varoittaa avoimien tallennuskahvojen voivan jättää profiilitallennusta jäljelle.
Profile-SID:n johtaminen tarkistaa vain identiteetin.

Vanhaa profile-nimeä/SID:tä ei saa aktivoida uudelleen eikä sen jäänteitä liittää
uuden sukupolven aineistoon tai oikeuksiin. Täydellisen profiilitallennuksen
elinkaaren näyttö säilyy avoimena. Vapautuksen completion ei anna rearm- tai
kaatumispalautusvaltuutta; uusi Host, backend-alias tai uusi datajuuri ei
korvaa näitä protokollia.

## Todennettu näyttö ja jatko

Tietuemuodon siirrettävä koe läpäisi 28 tapausta nimetyllä testitarkisteella.
Windowsin tiedosto-/kontrollikoe läpäisi 53 tapausta oikeilla tiedostoilla,
ACL:illä, BCrypt-tarkisteilla ja poistokutsuilla. Prosessitodistukset olivat
siinä injektoituja. Tyhjän oikean testijobin torjunta kattoi prefixin 0;
erillinen delete-sharing-esto ei kuulunut tähän ajoon. Jaetun aikabudjetin
Windows-muistikoe läpäisi; tavallinen backend säilyttää oletusarvoisen rajansa.

Desktop-käännös, integraatio- ja yksikkötestien tyypit sekä 57 sovitintestiä
läpäisivät. Testijäljityksen tarkennuksen jälkeen integraatiotyypit tarkistettiin
uudelleen; muuttumattomia sovitintestejä ei uusittu.

Commitin `d7b8c4a4ff70` natiivipaketti läpäisi kaksi toiminnallista
Node-isännän tapausta. Ensimmäisessä oikea broker ja eristetty worker tekivät
MCP-tilakierroksen ja Main-STOPin. Vasta todetun broker-exitin jälkeen testi
kutsui natiivin clean-vapautuksen ja saman completionin uusinnan. Toinen tapaus
vapautti käyttämättömän sessionin Hostin disable-polulta. Kaikkien 27 jäljitetyn
lapsen todellinen close havaittiin ilman kill-pyyntöjä; mukana oli kaksi
odotettua exit1-hylkäystä ja muut exit0:t. Jäljet pysyivät 512 tapahtuman
rajoissa. Backendit olivat synteettisiä ja saman Node-isännän sisällä; mallia,
GPU:ta tai sää-APIa ei käytetty. Tämä ei ole oletus-Electronin E2E eikä erillinen
profiili-/Job-/DACL-/verkkoinventointi.

Epäonnistumiset säilyvät erillisinä. Ensimmäinen natiivin kontrollikokeen
käännös pysähtyi väärään vakionimeen ennen testin ajoa. Ensimmäinen toiminnallinen
ajo pysähtyi identiteettiapurin aikarajaan, ja sen historiallinen child.close
jäi tuntemattomaksi. Seuraavassa jäljitetyssä ajossa bootstrap-apurin
synkroninen käynnistys ylitti alkuperäisen määräajan. Valtuustavuja ei lähetetty,
kaikki omat lapset sulkeutuivat ja epävarmuus esti toisen tapauksen. Tuore
onnistunut ajo ei selitä aiempien viiveiden käyttöjärjestelmätason syytä.

Automaattisen pyynnön ja natiivin vapautuksen yhteinen ajonäyttö, saman Mainin
uusi generation, kaatumispalautus ja oletus-Electron-kooste ovat jatkotyötä. Koko minimipaketin
FMI-, CPU/GPU-, verkko-, tiedosto- ja sulkurajojen hyväksyntä säilyy #10:ssä.
