# Rajattu 4B-mallin CPU-lataus eristyksessä

T09e / #28 jatkaa parentia #10 ja [SDK:n LPAC-koetta](sdk-isolation-probe.md#t09d-nimetty-lpac-sdk-koe).
Tila: rajattu oikean 4B-mallin CPU-latauskoe on ajettu 4.11.2026.
Kontrollin ja nimetyn LPAC + registryRead -profiilin kaikki kuusi tapausta
läpäisivät. Tulos koskee tätä koepakettia; koko sovelluksen eristys ja
alla erotetut jatkoportit eivät valmistu tämän näytön perusteella.

## Tavoite ja kiinteä kokoonpano

Lataa hyväksytty Qwen3-4B Q4_K_M ja vapauta se CPU:lla sekä tavallisessa
kontrollissa että nimetyssä LPAC + registryRead -profiilissa. Käytössä on
#26:ssa valmistunut korjattu erillinen Node 24.22.2 ja SDK 3.22.2:n CPU-binääri.
Tämä ei vaihda sovelluksen Electron-runtimea tai valitse oman Node-haaran
tuotantotoimitusta. GPU, keskustelukonteksti, generointi ja verkkopyynnöt
rajataan pois. Mallia tai riippuvuuksia ei hankita kokeen aikana.

Painon lähtötiedot ovat [hyväksytyssä profiilissa](../../resources/models/qwen3-4b.json).
Kokeen suljettu sopimus tarkistaa sen yhden hyväksytyn mallin tunnisteen,
2 497 280 256 tavun koon, SHA-256:n ja chat-templaten tarkisteen. Ajuri ei
hyväksy komentoriviltä mallipolkua, URL:ia, capabilityjä tai mielivaltaisia
moottoriparametreja.

## Koekopio, lukitus ja tiedostoraja

Ajuri tarkistaa alkuperäisen paikallisen painon ja tekee siitä oman tavallisen
kopion koepaketin `package/model.gguf`-polkuun. Symlinkkejä tai hardlinkkejä
ei hyväksytä. Alkuperäiseen tiedostoon tai mallikansion oikeuksiin ei kirjoiteta.
Koekopion tarkistus ja lataus tapahtuvat seuraavasti:

1. Host tarkistaa omistetun koepuun, tiedostotyypin ja kopion oikeudet.
2. Host avaa painon GENERIC_READ / FILE_SHARE_READ -kahvan ja pitää sen
   myös virhepolun Job-siivouksen ajan. Kahva ei periydy workerille.
3. Hostin omat write- ja delete-avaukset tuottavat täsmälleen
   ERROR_SHARING_VIOLATION (32). Näin tiedoston jakamisrajoitus on mitattavissa.
4. Worker tarkistaa kopion koko SHA-256:n ja koon pin-kahvan ollessa pidettynä.
   Vasta sitten SDK saa kiinteän paikallisen tiedostopolun.
5. Kahva vapautetaan omien prosessien poistumisen jälkeen.

Lukitus estää write/delete-avaukset myös suojaamattomalta kontrollilta.
Sitä ei raportoida LPAC:n ACL-estona. Erillinen pieni
`weights-write.fixture` saa paketin vastaavat lukuoikeudet ilman pin-kahvaa:
sen kirjoitus onnistuu kontrollissa ja sen pitää estyä LPAC:ssa.
Lisäksi worker mittaa paketin luvun, scratch-kirjoituksen, private-luvun ja
-kirjoituksen, kooditiedoston muuttamisen ja AAP-only-fixturen luvun.
AAP-luku onnistuu kontrollissa ja estyy LPAC:ssa. Testitiedot ovat synteettisiä.

Tämä on erillisen omistetun koepuun menetelmä. Se ei hyväksy mielivaltaisen
käyttäjän valitseman ulkoisen mallikansion kaikkia polku-, linkki- ja
samanaikaisen vaihtamisen tapauksia käyttöversiossa. Sama käyttäjätili ja
luotettu kehitysajuri eivät ole tämän kokeen hyökkääjäprosesseja.

## Prosessi ja kuormarajat

Uusi `run-model-candidate` hyväksyy vain t09e-profiilin, control/lpac-tilat
ja once/missing-model/hold-elinkaaret. Vanhojen SDK-verbien oikeuksia ja
mallikäynnistysvalintoja ei avata. LPAC:n capabilityjoukko on täsmälleen
registryRead, SE_GROUP_ENABLED; kontrollin joukko on tyhjä.

Host asettaa ennen ResumeThreadiä Jobiin yhden aktiivisen prosessin rajan,
yhden loogisen suorittimen affiniteetin, BelowNormal-prioriteetin ja 6 GiB:n
Job-commit-muistirajan. Rajat luetaan takaisin ja workerin prioriteetti sekä
affiniteetti tarkistetaan. Muistiraja ei ole fyysisen muistin tai lämpötilan
takuu. Ajuri edellyttää ennen valmistelua ja jokaista tapausta vähintään
6 GiB vapaata muistia; tarkistus ei varaa muistia muita ohjelmia vastaan.

SDK käyttää CPU:ta ja yhtä säiettä. Malliasetukset ovat gpuLayers 0,
vocabOnly false, useMmap true, useMlock false, checkTensors false ja
lazyMode false. Latauksen keskeytyssignaali on 90 sekuntia, hostin koko
worker-aika enintään 120 sekuntia. Job omistaa poikkeuksessa suljettavan
malliprosessin. Piilotettu koekonsoli säilyy #26:ssa kuvatulla tavalla;
se ei ole tuotannon konsolieristyksen hyväksyntä.

Tulokset kulkevat saman rajatun worker-envelope-kehystyksen kautta kuin
SDK-kokeessa. Worker ei voi kirjoittaa hostin token-, pin-, resurssi- tai
siivouskuitteja. Tässä kokeessa ei ole instrumentoitua SDK-helperiä.

## Kuuden tapauksen hyväksymisnäyttö

| Tapaus, kummassakin profiilissa | Vaadittu näyttö |
| --- | --- |
| Normaali | CPU-alustus, koko painon tarkiste, oikea natiivi mallilataus, metadata ja chat-template, GPU-kerroksia 0, mmap käytössä sekä model- ja llama-dispose getterien vahvistamana. |
| Puuttuva malli | Host ja worker toteavat kiinteän tiedoston puuttumisen; SDK:n loadModel tuottaa ENOENT:n, hallittu malliprosessin exit 17, hostin exit 1 ja llama-dispose. Muu virhe ei kelpaa. |
| Owner-loss ladatun mallin aikana | Hostin tarkistettu worker on saanut model-loaded-tuloksen ja jäänyt hold-vaiheeseen. Ajuri sulkee vain nimetyn omistajansa; kaikki omat prosessit ja konsoli poistuvat. |

Ajuri etenee kontrollin normaalista polusta sen kahteen poikkeukseen ja
vasta sitten LPAC:n vastaavaan kolmikkoon. Epäonnistunut oikeus-,
identiteetti-, lataus- tai siivousportti pysäyttää matriisin.
Jokaisessa tapauksessa tarkka omien PIDien joukko tarkistetaan poissaolevaksi
ennen korjaavaa siivousta. Hätäsiivous ei kelpaa läpäisyksi.
Omat profiilit, staged-aineisto ja yhteinen template poistetaan.
Alkuperäisen painon tarkiste ja tiedostoidentiteetti varmennetaan lopussa.

Mmap-lataus ja metadata eivät osoita kaikkien tensorien käyttöä laskennassa,
vastausten laatua, kontekstin muistinkulutusta tai inferenssin suorituskykyä.
Niistä ei tehdä päätelmiä tämän kokeen perusteella.

## Valmistelu ja myöhempi ajo

Kevyet Node-rajatestit käyttävät vain pieniä synteettisiä tulosrivejä.
`model-results.test.mjs` ei importoi käynnistyvää mallikoetinta tai ajuria.
`check-model-scope.mjs` on erikseen ajettava kielteinen natiivikoe vasta
hostin käännöksen jälkeen; se ei lue GGUF:ää tai luo onnistuvaa malliprosessia.

Varsinainen ajo tehdään vain tämän lähdeversion käännetyllä ja
katselmoidulla hostilla, kun koeympäristön kuormarajoitus sallii sen.
Rajattu `run-model-limited.ps1` asettaa oman lyhytikäisen prosessinsa
BelowNormal-prioriteetin ja yhden suorittimen affiniteetin ennen Node-ajurin
käynnistämistä. Ajuri lukee oman PIDinsä todelliset Windows-arvot takaisin
ennen hakemistojen tai painojen valmistelua, ennen jokaista tapausta ja
ennen lopun painotarkistusta. Väärä tai puuttuva raja pysäyttää raskaan työn.
`-CheckOnly` varmentaa saman portin ilman koepakettia tai mallipainoja.
Suora rajoittamaton Node-kutsu hylätään ennen runRootin luontia.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\e2e\isolation\run-model-limited.ps1 -CheckOnly
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\e2e\isolation\run-model-limited.ps1
```

Komento käsittelee usean gigatavun painoa. Se ei kuulu tavalliseen testiajoon.
Käynnistin ja valmistelun ajuri ajetaan matalalla prioriteetilla ja yhdellä
suorittimella; workerin Job-raja varmennetaan siitä erikseen.
Lähteiden ja binäärien tarkisteet jäädytetään ennen ajoa. Vanhan hostin
onnistunut SDK-koe ei osoita uuden model-verbin toimivuutta.

Raakatulokset säilyvät ohitetussa `.artifacts/tests/isolation/model-runs/`-
puussa. Julkinen laadullinen tulos, tehdyt tarkistukset, ajamattomat kohdat
ja tokeniseuranta kirjataan issueen #28. Parentin #10 verkko-/FMI-, GPU-,
MCP- ja koko sovelluspaketin hyväksymisehdot säilyvät erillisinä.


## Mitattu tulos

| Tapaus | Kontrolli | LPAC + registryRead |
| --- | --- | --- |
| Oikea lataus ja normaali vapautus | Läpäisi | Läpäisi |
| Puuttuva malli, SDK:n ENOENT ja hallittu sulku | Läpäisi | Läpäisi |
| Omistajan poistuminen mallin ollessa ladattuna | Läpäisi | Läpäisi |

Kaikissa kuudessa tapauksessa valmisteluajurin kuormarajat ja malliprosessin
Job-rajat varmennettiin. Neljä todellista mallilatausta tarkisti koko painon
SHA-256:n pidetyn pin-kahvan aikana ja käytti vocabOnly=false-asetusta.
Metadata, chat-template, GPU-kerrosten nolla ja mmap varmennettiin.
Normaalipolkujen model- ja llama-dispose sekä puuttuvan painon täsmällinen
ENOENT toimivat. Omistajan sulkeminen tapahtui vasta model-loaded/hold-näytön jälkeen.

Kontrollin kaikki seitsemän tiedosto-operaatiota onnistuivat. LPAC:n paketin
luku ja scratch-kirjoitus onnistuivat, viisi muuta operaatiota estyi EPERM:llä.
Tähän sisältyvät erillisen painofixturen kirjoitus ja AAP-only-fixturen luku.
Hostin lukituskokeen write/delete-estot olivat erikseen sharing violation 32.

Omien prosessien ja konsolien poistuminen todettiin ennen korjaavaa siivousta.
Kaikki kuusi siivousta onnistuivat ilman hätätoimia; profiilit, staged-puut
ja yhteinen template poistuivat. Alkuperäisen painon SHA-256, koko,
tiedostoidentiteetti ja muokkausaika säilyivät. Kontrollin omistajansulkutapauksessa
tilapäisen tiedostonpoiston ensimmäinen yritys sai EPERM:n; rajattu uusinta
onnistui. Prosessit olivat jo poistuneet ennen tiedostonpoistoyrityksiä.
Ensimmäinen virhe säilyy paikallisessa tuloksessa; sen syytä ei yksilöity.

Host käännettiin varoitukset virheiksi käsittelevillä asetuksilla. Kaikki
18 kielteistä käynnistystapausta ja 588 kevyttä yksikkö-/rajatestiä läpäisivät.
CheckOnly varmisti rajatun ajurin; rajoittamaton ajuri hylättiin ennen
painovalmistelua. Kummankaan tarkistuksen aikana ei syntynyt mallikoepuuta.
Lähde- ja binääriversiot sekä kuuden tapauksen raakatulokset on sidottu
tarkistein paikalliseen tarkistusraporttiin. Julkinen loppuraportti,
riippumaton katselmus ja tokeniseuranta kuuluvat issueen #28.

### Näytön rajat

Suora LPAC-tokenkysely palautti edelleen null / virhe 87 / tavumäärä 0,
ei true-arvoa. Nimetyssä profiilissa tarkistettiin käynnistysasetuksen lisäksi
paketti-identiteetti, tarkka registryRead-capabilityjoukko, low integrity
sekä kontrollista poikkeava AAP-lukuesto. Tämä aiemmasta SDK-kokeesta tuttu
kyselyraja säilyy näkyvissä eikä sitä tulkita onnistuneeksi tokenlipun luvuksi.

Koe ei luonut keskustelukontekstia, generoinut tekstiä tai käyttänyt GPU:ta
ja verkkoa. Se ei valitse registryReadia, jaettua koekonsolia tai korjattua
omaa Node-runtimea tuotantoratkaisuksi. Parentin #10 FMI-, GPU-, MCP-,
Electron-toimitus- ja koko minipaketin hyväksymisportit pysyvät avoimina.
