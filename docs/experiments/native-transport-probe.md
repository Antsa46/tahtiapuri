# Natiivin mallityöntekijän viestintäkoe

Tämä T09:n osakoe valmistelee toimitettavaa CPU-runtimea. Koe ei vielä
sisällä llama.cpp:tä, mallipainoja, Electron-liitäntää tai verkkoa.
Se ei hyväksy #10:n alkuperäisiä verkko-, tiedosto- tai koepakettiehtoja.
Ajotapojen omistava sopimus on
[mallien ajotavoissa](../architecture/model-execution-profiles.md).

## Toteutus ja luottamusraja

Koekoodi pysyy tests/e2e/isolation/-puussa; sovellus ei importoi sitä.
Uusia kolmannen osapuolen riippuvuuksia ei lisätä. Kaksi pientä C++-ohjelmaa
käyttää olemassa olevaa Windows SDK:ta ja MSVC-kääntäjää:

- native/transport-host.cpp määrittelee kuljetuskokeen; yhteinen
  native/isolated-launcher.h omistaa luotetun käynnistyksen. Se tarkistaa todellisen
  lapsiprosessin tokenin ja Job-jäsenyyden ennen suorittamisen aloittamista.
- native/transport-worker.cpp on synteettinen työntekijä. Sen virhekomennot
  kuuluvat vain testiin, eivät tuotteen tulevaan rajapintaan.
- native/transport-wire.h omistaa koekanavan kehystyksen.
  native/transport-resources.h rajaa tämän kokeen ACL- ja siivousavun.
- run-transport.mjs omistaa tapausten järjestyksen ja jälkisiivouksen.
  transport-results.mjs hylkää ristiriitaisen näytön.

Työntekijälle periytyvät vain sen lukuputki, kirjoitusputki ja NUL-kahva
vakiovirroille. Omistajakanava, Job, prosessikahvat ja synteettinen salainen
tiedostokahva eivät kuulu sallittuun luetteloon. Työntekijän lokiin kirjoittama
väärennetty launched-tietue ei pääse koeraporttiin. Lapsen oma ilmoitus
eristyksestä ei ole oikeusnäyttö.

Käynnistäjä luo nollan capabilityn AppContainer- tai LPAC-ehdokkaan sekä
tavallisen kontrollin. Pyydetty LPAC-asetus ja tokenkyselyn tulos erotetaan.
Tunnettu kyselyn null / 87 / 0 jää epävarmaksi; toimiva viestiyhteys ei
vahvista LPAC-lippua. Verkkoliikennettä ei yritetä: networkVerified on false.

## Viestit, kuorma ja sulku

Kaksi anonyymia putkea ei avaa kuuntelevaa porttia. 48 tavun otsake sisältää
tunnisteen, version, operaation, pyyntönumeron, sisällön koon ja käynnistäjän
satunnaisen 32 tavun istuntotunnisteen. Sisällön enimmäiskoko on 16 KiB.
Otsake tarkistetaan ennen sisältöpuskurin varaamista. Tunniste ei korvaa
kahvojen käyttöoikeusrajausta.

Työntekijän raja on 64 pyyntöä / 1 MiB, käynnistäjän vastausraja
32 kehystä / 256 KiB. Kehyksen lukemisen aikaraja on 2,5 sekuntia.
Työn aloitus, valmistuminen, peruutus, tilakysely ja sulku ovat synteettisiä;
ne eivät vielä suorita tai peru oikeaa mallilaskentaa.

Putkeen kirjoittaminen voi odottaa lukijaa. Erillinen vahtisäie katkaisee
Jobin omistajakanavan sulkeutuessa tai kokonaisajan ylittyessä, peruu
odottavan synkronisen I/O:n ja käyttää viimeisenä prosessisulun aikarajaa.
Myös diagnostiikka kirjoitetaan vahdin alaisena.

Job sallii yhden prosessin, yhden suorittimen, BelowNormal-prioriteetin
ja 256 MiB:n commit-rajan. Nämä ovat koetyöntekijän rajat, eivät kielimallin
asetuksia tai lämpötilatakuu. Käännös ja kokeet ajetaan peräkkäin.

## Omistus ja siivous

Jokainen tapaus käyttää uutta merkittyä koehakemistoa. Ennen ACL-muutoksia
tarkistetaan koko sallittu puu, tavalliset tiedostot, yksi kova linkki ja
reparse-pisteiden puuttuminen. Käyttäjäaineistoa ei kopioida.
Kaikki resurssit, myös marker, profiilikuitti ja käynnistäjä, saavat
suojatut oikeudet ennen juurikansion oikeuksien muuttamista.

Lapsen päättymistä ja Jobin tyhjenemistä odotetaan ennen siivouskatkaisua.
Profiilia ei poisteta, jos Jobin tyhjeneminen on epävarma.
Puuttuva launched-tietue ei todista tyhjää prosessipuuta. Erikseen validoitu
create-child-virhetulos voi todistaa, ettei lasta luotu ja että tyhjä Job
sekä profiili on siivottu. Se sallii jäännösten poiston, mutta koe jää
epäonnistuneeksi. Myös raportin täydellisyys tarkistetaan.

Käynnistäjän pakkosulussa erillinen tarkkailija avaa ensin oikean
työntekijän prosessikahvan ja tarkistaa ohjelmapolun. Se odottaa
päättymissignaalia ennen profiilin poistoa. Hätäsiivous ei muuta
epäonnistunutta koetta hyväksytyksi.

## Ajaminen

Olemassa olevat C++-työkalut, Windows SDK ja projektin lukittu Node vaaditaan.
Komennot ajetaan projektin juuresta:

~~~powershell
powershell -NoProfile -File tests/e2e/isolation/build-transport.ps1
powershell -NoProfile -File tests/e2e/isolation/run-transport-limited.ps1 -CheckOnly
powershell -NoProfile -File tests/e2e/isolation/run-transport-limited.ps1 -Smoke
powershell -NoProfile -File tests/e2e/isolation/run-transport-limited.ps1
node --test tests/e2e/isolation/transport-results.test.mjs tests/e2e/isolation/model-load-limits.test.mjs
~~~

Lähde- ja binääritarkisteet sekä raakaraportit jäävät
.artifacts/tests/isolation/transport/-puuhun. Niitä ei julkaista.
Ajuri pysähtyy ensimmäiseen epäonnistumiseen ja erottaa yritetyn tapauksen
vielä ajamattomista.

## Näyttö ja rajat

Peruskoe läpäisi kontrollin, AC:n ja nollacapability-LPAC-ehdokkaan.
Varsinainen 19 tapauksen matriisi läpäisi kaikissa kolmessa ajotavassa: 57/57.
Kaikki profiilit ja koehakemistot poistuivat ilman hätäkorjausta.
Kohdistetut tulosvalidoinnin ja kuormarajojen testit läpäisivät 59/59.
Tapaukset kattavat normaalit ja paloitellut viestit, maksimikoon,
synteettisen työn valmistumisen/peruutuksen, sulun kesken työn,
virheellisen tunnisteen/version/istunnon/numeron/operaation/koon,
katkenneen otsakkeen/sisällön, virheellisen vastauksen, vastaustulvan,
lukemattoman putken, omistajan katoamisen, käynnistäjän pakkosulun,
työntekijän kaatumisen, pyyntörajan ja kelvollista viestiä seuraavan EOF:n.
Erilliset poistumiskoodit estävät myöhempää EOF:ää tai aikarajaa peittämästä
virheellisen pyynnön hyväksymistä.

Alkuvaiheen epäonnistuneet ajot säilyvät paikallisessa näytössä:

- Juuren ACL-muutos poisti omistetuilta resursseilta perityt oikeudet.
  Tyhjät DACL:t varmennettiin ja täsmällinen jäännös korjattiin ja poistettiin.
  Nyt kaikki resurssit suojataan ennen juuren muutosta.
- Välitön Job-lukumäärän tarkistus epäonnistui kerran lapsen päättymisen
  jälkeen. Nyt tyhjenemistä odotetaan enintään kaksi sekuntia.
  Havainto ei yksilöi Windowsin sisäistä ajoitussyytä.
- AC-käynnistys palautti 203 rajatulla ympäristöllä. APPDATA, LOCALAPPDATA
  ja USERPROFILE lisättiin osoittamaan omaan scratch-kansioon, minkä jälkeen
  peruskokeet läpäisivät. Yksittäistä välttämätöntä muuttujaa ei eroteltu.

Mallikirjaston alkuperä, versio ja lisenssi, todellisten painojen luku,
generointi, tiedosto- ja verkkokieltojen yrittäminen, CPU/CUDA sekä
sovelluksen prosessien yhteistoiminta ovat seuraavaa näyttöä.
Koebinääriä tai testikomentoja ei toimiteta sovelluksen mukana.

## Lähteet

- [Microsoft: Anonymous Pipe Operations](https://learn.microsoft.com/en-us/windows/win32/ipc/anonymous-pipe-operations)
- [Microsoft: Anonymous Pipe Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/ipc/anonymous-pipe-security-and-access-rights)
- [Microsoft: Implementing an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)

Käynnistimen erottamisen jälkeen synteettinen matriisi ajettiin uudelleen:
57/57 läpäisi. Oikean mallin jatko on [CPU-mallikokeessa](native-cpu-model-probe.md).
