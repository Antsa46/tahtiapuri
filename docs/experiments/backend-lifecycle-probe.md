# Backendin uudelleenkäynnistys ja rajatut virhetilanteet

Tämä issue #10:n jatkokoe käyttää
[backendin normaalikokeen](backend-isolation-probe.md) natiivikäynnistintä,
koepäätettä ja oikeusrajoja. Sovelluksen oletusajotapaa ei vaihdeta.
Rajattu Batch A sisältää viisi prosessielinkaarta sekä kontrollissa että
LPAC-ehdokkaassa: yhteensä kymmenen. Batch A on toteutettu ja sen rajattu lähde-/raakanäyttökatselmus on hyväksytty.

## Sama data uudessa istunnossa

Ensimmäinen backend tallentaa synteettisen havaintopaikan ja aktiivisen
valinnan. Se suljetaan normaalisti. Ennen seuraavaa käynnistystä vaaditaan
lapsen ja brokerin poistuminen, tyhjä Job, säilyvän datajuuren DACL-palautus,
LPAC-profiilin poisto sekä vanhan worker-juuren poistuminen.

Toinen worker saa uuden työjuuren, profiilinimen, viestikanavan noncet ja
sovellusistunnon. Se lukee saman datahakemiston; tallennettua tiedostoa ei
kopioida uuteen paikkaan. Revision, kohdetunnisteen ja aktiivisen paikan
pitää täsmätä. Seuraava muutos varmistaa myös uuden profiilin kirjoitusoikeuden.
Case-juuri poistetaan vasta molempien vahvistettujen elinkaarien jälkeen.

Kummastakin oikeusprofiilista tallennetaan yksi kokonainen taivasvastaus
poistettavan case-juuren ulkopuolelle. Positiivisen sovittimen valinnainen
koehook saa kopion alkuperäisistä sisemmän kehyksen tavuista ja niiden
istunto-/pyyntö-/järjestysmetatiedot. Hook rajataan yhteen omaan
sky.snapshot-vastaukseen ja enintään 16 MiB:iin. Havainnoijan virhe hylkää
kokeen. Tavut, pituus ja tarkiste mahdollistavat riippumattoman jälkiparsinnan.
Aineisto pysyy paikallisessa .artifacts/-puussa.

## Täsmälliset kielteiset tulokset

| Tapaus kummassakin profiilissa | Vaadittu havainto |
| --- | --- |
| Omistajan EOF PREPAREDin jälkeen ennen STARTia | Lapsi luotu mutta jatkamatta; lapsen exit 42, brokerin exit 1; syy 1, owner-eof, virhe 109; nolla sovellusviestiä |
| CLOSE ilman hyväksyttyä shutdownia | Lapsen exit 67, brokerin exit 1; syy 3, unexpected-worker-exit, virhe 1067; kaksi sisempää kehystä ja yksi omistajan APP |
| Yhden 0xff-tavun sisältävä APP | Lapsen exit 65, brokerin exit 1; sama syy/virhe; kaksi sisempää kehystä ja kaksi omistajan APPia |

Jatkettujen tapausten laukaisua edeltävät aito ready ja validoitu
probe.boundaries, sisemmät kehykset 1 ja 2. Pelkkä ready voi kilpailla
asynkronisen tiedostokuitin kanssa. Viimeinen kirjoitus tyhjennetään ennen
seal-operaatiota; omistajan stdin pysyy auki eksplisiittistä EOF-koetta lukuun
ottamatta.

Erillinen raakaomistaja ja tulosvalidaattori tarkistavat odotetun virheen.
Positiivisen sovittimen onnistumissääntöjä tai ChildPort.exitin ehtoja ei
löysennetä. Jokainen negatiivinen tarvitsee passed=false-arvon, täsmällisen
virheallekirjoituksen, tyhjän Jobin, palautetut pysyvät DACL:t,
LPAC-profiilin siivouksen sekä lapsen ja brokerin todetun poistumisen.
Myös ulomman ja sisemmän kanavan on päätyttävä ehjänä.

Stderr-tavumäärän pitää olla nolla. Jatkettujen virhetapausten
stderrComplete säilytetään havaittuna totuusarvona: peruutus voi kilpailla
stderrin EOF:n kanssa. false tarkoittaa vahvistamatonta valmistumista.
Ennen STARTia arvo on false. Negatiivista tapausta ei hyväksytä pelkästään
jonkin virheen tai aikakatkaisun perusteella.

## Ajaminen ja avoin näyttö

Rakennuksen ja uusien lähteiden katselmuksen jälkeen projektijuuresta:

~~~powershell
powershell -NoProfile -File tests/e2e/isolation/build-backend-probe.ps1
powershell -NoProfile -File tests/e2e/isolation/run-backend-lifecycle-limited.ps1 -Mode unit
powershell -NoProfile -File tests/e2e/isolation/run-backend-lifecycle-limited.ps1 -Mode batch-a
~~~

Ajuri lukitsee nykyisen rakennusmanifestin sekä omat uudet lähteensä ja
tarkistaa ne uudelleen sarjan päättyessä. Kaikki ajot ovat peräkkäisiä,
yhdellä suorittimella ja BelowNormal-prioriteetilla. Ensimmäinen odottamaton
virhe pysäyttää sarjan ja säilyttää epävarman työtilan.

Batch A läpäisi 10/10 elinkaarta: neljä normaalia uudelleenkäynnistysparien
istuntoa sekä kuusi täsmällistä virhetapausta. Molempien profiilien toinen
worker luki samasta datajuuresta revision 2 sekä saman kohdetunnisteen ja
aktiivisen valinnan, ja tallensi revision 3. Kaikki Jobit tyhjenivät,
pysyvät DACL:t palautettiin, viisi LPAC-profiilia poistettiin ja kaikki
worker- sekä lopulliset case-juuret siivoutuivat. Kontrollit eivät luoneet
AppContainer-profiileja. Ennen STARTia katkaistuissa kahdessa tapauksessa
Node-sovelluskoodia ei suoritettu.

Kohdistetut 43 testiä ja ajurin syntaksitarkistus läpäisivät. Erillinen
RESULTin saapumislippu estää virheellisen ensimmäisen kuitin peittymisen
myöhemmän alle; tämä kattaa myös JSONin null-/skalaari-/taulukkosisällöt.

Riippumaton katselmus tarkisti raakakuitit ja saman datajuuren käytön.
Molemmat alkuperäiset taivasviestit parsittiin uudelleen nykyisillä
sovellusvalidaattoreilla: kumpikin sisälsi 5 079 yksilöllistä kohdetta,
oikean istunnon ja pyynnön sekä täsmäävät tavumäärät ja kehystarkisteet.
Kaikki kuusi negatiivista tulosta validoitiin uudelleen. Jatkettujen
virhetapausten stderrComplete oli tässä ajossa true ja havaittu tavumäärä
nolla; ennen STARTia arvo pysyy false-arvona. Suoran LPAC-lippukyselyn
null/87/0-epävarmuus säilyy.

Myöhemmän Batch B:n kesken työn katkaisu, osittainen/ylisuuri natiiviotsake
ja ulostulon vastapaine sekä raportoivan watchdog-sulun näyttö käsitellään
erikseen. Verkkoyritykset,
MCP, FMI, oikea malli ja GPU kuuluvat seuraaviin portteihin. Issue #10:n
alkuperäiset hyväksymisehdot pysyvät avoimina.
