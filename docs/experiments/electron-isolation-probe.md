# Electronin Node-tilan eristyskäynnistyksen koe

T09b / #25 selvittää jo hankitun Electronin Node-tilan yhteensopivuuden
samassa synteettisessä Windows-koeympäristössä kuin [T09a](windows-isolation-probe.md).
Tämä on yhteensopivuusselvitys, ei mallimoottorin tai havaintokäytön eristyksen
hyväksyntä. T09a:n verkkonäyttö ja LPAC:n jälkeläiskäynnistys ovat avoimia.

## Toistaminen ja toimitettu paketti

Projektijuuresta Windows PowerShellissä:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\e2e\isolation\run.ps1 -Probe electron
```

Koe tarvitsee saman olemassa olevan MSVC/SDK-työkaluketjun ja projektin
Windows Node -runtimen kuin T09a. Run.ps1 kääntää nykyisen testihostin;
SkipBuild sallitaan vain jo käännetylle nykyiselle lähteelle. Ajuri ei asenna
tai lataa mitään. scripts/dev/toolchain.json omistaa Electronin version ja
arkiston SHA-256:n. Olemassa oleva arkisto tarkistetaan ennen purkua.

Arkiston polut tarkistetaan ja sisältö puretaan uuteen omaan templateen.
Jokainen tapaus saa materialisoidun kopion, ei lähteen hardlinkkejä tai
ulkopuolisia junctioneita. Koko staged-puu tarkistetaan ennen ACL-grantteja:
reparse-polut, monilinkkiset tiedostot ja yli 2000 solmun puu
hylätään. Koepaketin oikeudet luetaan takaisin. Koodi on vain luettavana,
oma scratch kirjoitettavana ja synteettinen private erillään.
Raaka-aineisto jää .artifacts/tests/isolation/electron-runs/-puuhun.

## Kiinteä käynnistys ja näyttö

Testihostin run-electron valitsee itse package/electron.exe- ja
package/runtime-probe.mjs-polut. Kiinteät --preserve-symlinks ja
--preserve-symlinks-main estävät moduulilataajan tarpeettoman realpath-
kanonisoinnin koepuun ulkopuolisten esivanhempien kautta. Koko paketti on
jo tarkistettu ilman symbolisia linkkejä; OS:n tiedostoraja pysyy samana.
Probe tarkistaa, että process.execArgv sisältää juuri nämä kaksi optiota.
Vapaita Node-optioita ei välitetä. Ympäristön sallittujen listaan lisätään
vain ELECTRON_RUN_AS_NODE=1. NODE_OPTIONS, NODE_PATH, inspector ja muut
ulkopuoliset Electron-optiot eivät periydy. Sovelluksen UtilityProcess-
ajotapaa tai fuseja ei muuteta. Ajettava ohjelma, skripti ja argumentit
eivät tule mallilta tai yleisestä APIsta.

Job liitetään CreateProcess-attribuuttina, vain stdio-kahvat periytyvät ja
tokenin AppContainer-identiteetti/SID, capabilityt ja integrity tarkistetaan
ennen ResumeThreadiä. LPAC-kyselyn tuntemattomuus säilyy erillisenä T09a:n
mukaan. Hostin prosessirivi ei vielä osoita JavaScriptin suoritusta.

Koepääte ilmoittaa Electron-/Node-version, arkkitehtuurin ja PID:n sekä
suorittaa vain nimetyt synteettiset fs-operaatiot ja stdio-raportoinnin.
Se ei importoi verkkokirjastoja, SDK:ta tai käyttäjäaineistoa. Paketin luku,
scratch-kirjoitus, private-luku/kirjoitus ja moduulitiedoston muuttaminen
verrataan suojaamattomaan kontrolliin. EACCES/EPERM hyväksytään vain nimetyn
kielletyn tiedosto-operaation käyttöestoksi. Yllättävä oikeuksien laajeneminen
tai testikäytös keskeyttää matriisin.

Suojaamaton normaali käynnistys vaaditaan ensin. Myös kontrollille
tehdään hallittu JS-virhe ja owner-loss, jotta toimiva sulkuverrokki
säilyy. AC ja LPAC mitataan erikseen.
Onnistuneelle polulle tehdään hallittu JS-virhe ja erillinen owner-loss-koe;
odottava probe ilmoittaa valmiuden ennen omistajan tappamista. Jos hostin
identiteetti varmistuu mutta loader päättyy ennen JS-viestiä, epäonnistuminen
toistetaan erillisellä paketilla. Sama tulos on rajattu yhteensopivuushavainto,
ei onnistunut käynnistys. JS-virhe-/owner-loss-tapaukset jäävät siinä polussa
ajamatta. Kokonaistulos pysyy tällöin passed=false ja exit 1.

Stdout on enintään 256 KiB:n JSON-protokolla ja stderr enintään 1 MiB:n
diagnostiikka, josta säilytetään viimeiset 32 768 merkkiä. Virheellinen
JSON-muoto, turvaton PID ja katkennut viimeinen rivi hylkäävät protokollan. Molempien
kokeiden yhteinen process-harness.mjs omistaa rajatut odotukset ja oman
prosessin/profiilin siivouksen. Epävarma omistus säilyttää receiptin ja stagedin;
hätäsiivouksen tarve tai siivousvirhe hylkää tapauksen. Prosessien päätyttyä
EBUSY/EPERM/ENOTEMPTY-poistoa saa yrittää enintään viidesti (yhteensä
korkeintaan 1 s odotusta); yritykset ja lopullinen poistuminen kirjataan.
Muita virheitä ei toisteta eikä poistumatta jäänyttä puuta hyväksytä. Pelkkä prosessin
syntymisen ja puuttuvan JS-viestin yhdistelmä ei vahvista epäonnistumisen syytä.

## Jatkoportti ja tuloksen merkitys

Todennettu käynnistys avaa vasta node-llama-cpp:n erillisen yhteensopivuuskokeen.
SDK:n binäärikoelapsi, 4B CPU/CUDA ja koko desktop/backend/MCP-minipaketti eivät
kuulu tähän kokeeseen. FMI, DNS ja proxy eivät saa tästä uutta verkkolupaa.
T09b voi valmistua toistettavana yhteensopivuusselvityksenä, vaikka jokin
polku osoittautuu tällä kokoonpanolla toimimattomaksi. T09a ja T09 säilyttävät
alkuperäiset hyväksymisehtonsa.

## Lähteet ja tila

- [Electron: ympäristömuuttujat ja Node-tila](https://www.electronjs.org/docs/latest/api/environment-variables)
- [Node.js: kiinteät preserve-symlinks-optiot](https://nodejs.org/api/cli.html#--preserve-symlinks-main)
- [Electron: runAsNode-fuse](https://www.electronjs.org/docs/latest/tutorial/fuses)
- [T09a:n Windows-käynnistyksen menetelmä ja lähteet](windows-isolation-probe.md)

## Mitattu yhteensopivuustulos

Kiinteillä Node-optioilla ja samoin OS-oikeuksin saatiin seuraava tulos:

| Kokoonpano | Tulos |
| --- | --- |
| Suojaamaton kontrolli | Normaali ajo, hallittu JS-virhe ja owner-loss: 3/3 onnistuivat. |
| AppContainer, ei capabilityjä | Normaali Node/stdio/fs-ajo, hallittu JS-virhe ja owner-loss: 3/3 onnistuivat. Private-luku/kirjoitus ja moduulitiedoston muuttaminen estyivät. |
| LPAC, ei capabilityjä | Kaksi itsenäistä käynnistystä päättyi ennen JavaScriptiä: WSAStartup 10107 ja Electron-päätteen exit 0x80000003. |
| LPAC:n JS-virhe ja owner-loss | Ajamatta, koska Node-käynnistys ei toiminut. |
| Siivous | Kaikkien 8 tapauksen omat prosessit, profiilit ja staged-puut siivoutuivat; emergency-terminointia ei tarvittu. |

Arkisto vastasi lukittua SHA-256:ta. Onnistunut probe vahvisti Electron
45.2.1:n, sen Node 24.22.1:n ja x64-arkkitehtuurin. Kehityksen erillinen
Node-runtime on eri ohjelma kuin Electronin sisäinen Node.

Ilman kahta kiinteää preserve-symlinks-optiota AC:n käynnistys epäonnistui
asemajuuren realpath/lstat-tarkistukseen (EPERM). Nykyinen lataustapa
poisti tämän esteen ilman uusia tiedostograntteja. LPAC:n Winsock-virhe jäi
ennalleen; tästä ei päätellä sen tarkkaa syytä tai kaikkien LPAC-kokoonpanojen
mahdottomuutta.

Täydentävä kontrollin owner-loss paljasti transientin EBUSY-poistovirheen
prosessien jo päätyttyä. Alkuperäinen epäonnistunut ajo säilytettiin ja oma
koepuu poistettiin erillisessä palautussiivouksessa. Lopullisessa matriisissa
sama poistotilanne onnistui toisella raportoidulla yrityksellä. Viiden yrityksen
raja ja pysyvän virheen hylkäys säilyvät.

Protokollarajan 17 testiä läpäisivät: virheellinen JSON, turvattomat PID:t,
katkennut loppurivi ja ylittynyt stdout/stderr eivät kelpaa siivousmetadataksi
tai hyväksytyksi bootstrap-havainnoksi. Kokonaisajon passed=false ja exit 1
säilyvät LPAC:n kielteisen tuloksen vuoksi. Yhteensopivuusselvitys erottaa
onnistuneen AC-polun, toistetun LPAC-esteen ja sen ajamattomat jatkokokeet.

Seuraava portti on SDK:n ja sen binäärikoelapsen toimivuus AC-polussa.
T09a:n verkkonäyttö ja koko T09:n sovellus-/CPU-/GPU-vaatimukset ovat edelleen
avoimia; tästä ei tehdä tuotantoeristyksen hyväksyntää.

Yhteisen hostin ja siivousavun lopullinen natiiviregressio tuotti samat
11 tapauksen osatulokset kuin T09a: kaksi kontrollia, neljä AC:n
tiedosto-/identiteetti-/prosessi-/elinkaaritulosta, LPAC:n alkuperäinen
jälkeläisvirhe ja neljä erillistä LPAC-pääprosessidiagnoosia. Kaikki
siivoukset onnistuivat. Alkuperäiset kolme LPAC-jälkeläistapausta sekä
verkkonäyttö pysyvät avoimina; kokonaisexit säilyi 1:ssä.
