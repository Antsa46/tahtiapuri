# Backendin kesken työn katkaisu ja otsakerajat

Batch B jatkaa [hyväksyttyä elinkaarikoetta](backend-lifecycle-probe.md)
neljällä tapauksella sekä kontrollissa että LPAC-ehdokkaassa, yhteensä
kahdeksalla elinkaarella. Käynnistin, työntekijä, codec ja positiivinen
onnistumisvalidaattori säilyvät ennallaan. Uusi koekohtainen raakaomistaja
ja tulosvalidaattori ovat erillään Batch A:n kahden pienen kehyksen oletuksista.

## Rajattu sarja

| Tapaus | Laukaisu | Tarkka odotettu natiivitulos |
| --- | --- | --- |
| Omistajan EOF mallipyynnön odottaessa | Ready, boundaries, model.run ja saman työn assistant.submit-vastaus loading-tilassa; ei mallivastausta; omistajan EOF | Syy 1, owner-eof, virhe 109, lapsen exit 42, brokerin exit 1; neljä kokonaista sisäkehystä ja kaksi owner APPia |
| Osittainen otsake ennen STARTia | PREPARED, oikean START-otsakkeen ensimmäiset 20 tavua ja EOF | Syy 3, frame-truncated, virhe 109, exit 42/1; lasta ei jatketa, sovelluslaskurit nolla |
| Ylisuuri APP-otsake ennen STARTia | PREPARED, ehjä 48 tavun otsake ilmoittaa 65 537 tavun bodyn; ei bodya, STARTia tai EOF:ää | Syy 3, frame-header, virhe 13, exit 42/1; lasta ei jatketa, sovelluslaskurit nolla |
| Suuren taivasviestin vastaanottotauko ja KILL | Vastaanotto tauolle kolmannen sisäkehyksen alkuosassa; KILL; lapsen poistumisen tarkistus ennen vastaanoton jatkamista | Syy 4, owner-kill, virhe 995, exit 42/1; kaksi kokonaista sisäkehystä ja vain viimeisen sequence 3 -kehyksen osittainen sisältö |

Pending-mallityö on ohjelman todellinen ParentModelEngine-pyyntö, jonka
koeomistaja jättää vastaamatta. Oikeaa kielimallia ei ladata. Kehykset ovat
ready, probe.boundaries, model.run ja saman jobId:n submit-vastaus. Omistajan
lähettämät alustuksen ja submitin viestit sidotaan samaan istuntoon ja
kiinteään synteettiseen syötteeseen.

Otsakekokeet eivät löysennä normaalia koodaajaa. Raakaomistaja kirjoittaa
ainoastaan nimettyyn tapaukseen kuuluvan täsmällisen 20 tai 48 tavun
otsakkeen. Järjestysnumero, nonce ja ilmoitettu pituus säilytetään näytössä.
Kutsuja ei voi antaa vapaata suoritettavaa tiedostoa, polkua tai hyväksyttävää
virheluetteloa.

## Vastaanoton tauon näyttöraja

Tauko alkaa vasta validoidun kolmannen sisäotsakkeen ja ensimmäisten
hyötytavujen jälkeen. Julistettu vastaus on suuri ja vielä keskeneräinen.
Omistaja ei tyhjennä stdoutia taustalla tauon aikana. KILL kirjoitetaan ja
sen valmistuminen odotetaan riippumatta vastaanottokanavasta.

Erillinen rajattu prosessitarkistus toteaa lapsen poistumisen ennen stdoutin
jatkamista. Brokerin close-tapahtumaa ei odoteta ennen jatkamista, koska
siivouskuitit kulkevat samalla kanavalla. Myös virhepolun on palautettava
lukeminen ennen lopullista pelastus- ja sulkuyritystä.

Näyttö säilyttää otsakkeen, rajatun alkuosan, ilmoitetun ja vastaanotetun
koon sekä tauon, KILLin, lapsen poistumisen ja jatkamisen järjestyksen.
Osittaista JSONia ei nimetä validoiduksi taivasvastaukseksi. Jos kolmas
kehys valmistuu kokonaan, tavoiteltu tapaus ei toteutunut eikä sitä hyväksytä.

Koe todentaa suuren viestin keskeneräisyyden ja katkaisun vastaanottajan
tauon aikana. Se ei yksin osoita käyttöjärjestelmätasolla tietyn
kirjoitussäikeen jumittumista; siihen tarvitaan erillinen havainto.

## Hyväksyntä ja ajaminen

Kaikki tapaukset vaativat passed=false-arvon, täsmällisen virheallekirjoituksen,
ehjän ulomman kanavan, yhden STDERR- ja RESULT-kuitin, tyhjän Jobin,
pysyvien DACL:ien palautuksen sekä lapsen ja brokerin todetun poistumisen.
LPAC-haarassa profiilin poisto varmistetaan; kontrolli ei luo profiilia.
Vain nimetty vastaanottotauon tapaus saa päättyä osittaiseen sisäkehykseen.
Aiempi virhe tai virheellinen RESULT ei saa peittyä myöhemmän kuitin alle.

Havaittujen stderr-tavujen pitää olla nolla. Ennen STARTia stderrComplete
on false. Jatkettujen tapausten valmistumislippu säilytetään havaittuna
arvona, eikä false-arvoa nimetä vahvistetuksi tyhjäksi stderriksi.

Katselmoidun ja tarkisteisiin sidotun rakennuksen jälkeen projektijuuresta:

~~~powershell
powershell -NoProfile -File tests/e2e/isolation/build-backend-probe.ps1
powershell -NoProfile -File tests/e2e/isolation/run-backend-adverse-limited.ps1 -Mode unit
powershell -NoProfile -File tests/e2e/isolation/run-backend-adverse-limited.ps1 -Mode batch-b
~~~

Ensimmäinen odottamaton tulos pysäyttää sarjan ja säilyttää epävarman
koejuuren. Rakennusmanifesti, uudet omistajalähteet ja resurssipaketin
alkuperä tarkistetaan ennen ajoa sekä jokaisen elinkaaren jälkeen.

## Todennettu tulos

Uudet kohdennetut yksikkötestit läpäisivät 66/66. Oikealla Windows-runtimella
neljä tapausta läpäisivät sekä kontrollissa että LPAC-ehdokkaassa, yhteensä
kahdeksan elinkaarta. Riippumaton Astra-katselmus tarkisti lähteet,
alkuperäiset natiivikuitit, sisäkehysten sisällöt ja tarkisteet sekä
rakennuksen 33 ja resurssipaketin 39 tiedostopinniä.

Kaikki kahdeksan natiivitulosta säilyttävät passed=false-arvon ja taulukon
mukaisen virheallekirjoituksen. Hyväksyntä tarkoittaa tarkoituksellisen
virhetilanteen hallittua käsittelyä; positiivisen ChildPortin sopimus ei
muutu. Mallityötä odottaneet tapaukset tuottivat neljä kokonaista kehystä,
vastaanottotaukotapaukset kaksi ja otsakekokeet eivät yhtään.

Molemmissa vastaanottotaukotapauksissa kolmannen vastauksen ilmoitettu
hyötykoko oli 2 423 120 tavua ja sisältö jäi kesken. Säilytetty alkuosa
sisälsi odotetun vastauksen istunto-, pyyntö- ja operaatiotunnisteet.
Lapsen poistuminen todettiin ennen stdoutin jatkamista sovitun
1 500 millisekunnin koerajan sisällä. Koko taivasvastausta tai tietyn
käyttöjärjestelmän kirjoitussäikeen jumittumista ei tällä näytöllä vahvisteta.

Job tyhjeni ja pysyvät DACL:t palautettiin kaikissa kahdeksassa tapauksessa.
Neljä LPAC-profiilia poistettiin; kontrolli ei luo profiilia. Lapsen ja
brokerin poistuminen sekä kaikkien kahdeksan koejuuren poisto varmistettiin.
Jokaisen tapauksen alkuperä sidottiin samoihin tarkistettuihin lähteisiin.

Havaittuja stderr-tavuja oli nolla. Lukemisen valmistuminen todentui vain
kontrollin vastaanottotaukotapauksessa; muiden tapausten stderrComplete=false
säilyy epävarmuutena. LPAC-lippukyselyn null/87/0-havainto säilyy tuntemattomana.
Ulompien kehysten täydellistä raakatavuvirtaa ei säilytetty uudelleentoistoa
varten; niiden hyväksyntä perustuu katselmoituun, tarkisteisiin sidottuun
omistajaan. Alkuperäiset natiivikuittien bodyt ja osittaisen sisäkehyksen
otsake tarkistettiin erikseen. Raaka-ajot ja konekohtaiset havainnot pysyvät
paikallisina.

Aidon 20 sekunnin määräajan ja brokerin kaatumisen siivousnäyttö jää
erilliseksi portiksi: puuttuva RESULT ei osoita DACL-/profiilisiivousta.
Nykyinen koepääte tai sen lyhyen eliniän kokonaiskiintiöt eivät vielä ole
tuotannon backend. Verkkoraja, MCP, FMI, GPU ja koko sovelluspaketti pysyvät
erillisinä jatkoportteina. Issue #10:n alkuperäiset hyväksymisehdot säilyvät
avoimina.
