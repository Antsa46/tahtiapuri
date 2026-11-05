# Virallisen Noden rajattu stdio-koe

Tämä #10:n osakoe todentaa virallisen Noden ulkopuolelta käynnistetyn,
rajatun kaksisuuntaisen stdio-kanavan ja sen elinkaaren. Se ei vielä siirrä
sovelluksen backendia tai MCP:tä uuteen runtimeen. Jatkovaiheiden omistaja on
[backendin ja MCP:n eristyspolku](../architecture/backend-mcp-isolation.md).

## Lukittu kokonaisuus

Koe käyttää projektin Node 24.22.2 -työkalulukon virallista arkistoa.
Arkiston SHA-256 tarkistetaan, node.exe:n oma tarkiste johdetaan sen sisällöstä
ja paikallisen binäärin vastaavuus tarkistetaan. Nodeen tai libuviin ei
sovelleta paikallista korjausta. Koepääte ei käynnistä lapsiprosesseja eikä
käytä SDK:ta, mallipainoja tai verkkoa. Binäärin hankinta ja käännös ovat
erillisiä valmistelutoimia.

Erillinen node-stdio-host.cpp omistaa tämän koepolitiikan. Jaetun natiivin
mallikäynnistimen oletuksia ei muuteta. Koodit, nimetyt tiedostot ja ohjelma
kopioidaan tavallisiksi tiedostoiksi omaan merkittyyn työtilaan. Koodi on
luettava, scratch kirjoitettava ja private-aineisto erillään. AAP-fixture
vertaa AC:n ja LPAC-ehdokkaan tiedostokäyttäytymistä. Koodikirjoituksen
koetiedostoa ei pin-lukita: käyttöesto ei saa olla pelkkä jakolukon seuraus.

Broker lukitsee ja tarkistaa Node-/JS-/pakettitiedostot ennen lapsen
jatkamista. Job, täsmällinen capability-joukko, SID, integrity, affiniteetti
ja sentinel-kahvan periytymättömyys tarkistetaan. LPAC-ehdokas käyttää
registryRead-capabilityä; se ei tarkoita vain yhden rekisteriavaimen lupaa
eikä vielä hyväksy toimitusprofiilia. AC:lla capabilityjä on nolla.

## Konsoli, viestit ja sulku

Alkuperäinen CREATE_NO_WINDOW-kontrolli hylkäsi ensin brokerin perityn
konsolin. Lapsi oli tuolloin jo luotu suspendattuna, mutta sitä ei jatkettu.
Brokerin oma konsoliyhteys irrotettiin säilyttäen kolme standardiputkea.
Uusinta eteni Node-koodin ready-viestiin ja kuuteen kontrollin tiedostokokeeseen,
mutta havaitsi konsoli-istunnon ready-vaiheen jälkeen. Molemmat kielteiset
raportit ja työtilat säilyvät paikallisina. Tulokset eivät osoita Noden
oman AllocConsole-kutsun olemassaoloa.

Astran katselmuksessa rajattu DETACHED_PROCESS-kontrolli läpäisi. Sen jälkeen
erillinen kolmen normaalitapauksen ehdokas läpäisi. Täysi matriisi on oma
rakennusvalintansa; kumpikaan aiempi valinta ei siirry siihen automaattisesti.
Binääri, ajuri ja tulosvalidaattori rajaavat matriisin täsmälleen 15 tapaukseen.
AC sallii vain normal-tapauksen; kontrolli ja LPAC seitsemän nimettyä tapausta.

CREATE_NO_WINDOWin ikkunattomuus ja konsoli-istunnon puuttuminen erotetaan.
DETACHED-koe säilyttää kolme perittyä standardiputkea, mutta konsoliin
liittymisen pitää epäonnistua ennen resumea ja ready-viestin jälkeen.
Onnistuva AttachConsole hylkää tapauksen. Nämä ovat kaksi tarkistuskohtaa,
eivät jatkuva monitori tai yleinen lupaus mielivaltaisen natiivikoodin käytöstä.

TAIP-kehyksen otsake on 48 tavua, hyötykuorma enintään 16 KiB, kumpikin
suunta enintään 20 kehystä ja 64 KiB yhteensä. Istunto, pyyntönumero,
raakabittien magic, tiukka UTF-8, viestijärjestys ja kokonaisrajat tarkistetaan.
Työntekijän kehys ei voi esiintyä brokerin oikeus- tai siivouskuittina.
Stderr on erillinen, enintään 16 KiB; se ei ole tilakuittien lähde.

Shutdown hyväksytään vasta stdin:n EOF:n ja ehjän parserin jälkeen. Myös
saman tai myöhemmän syöte-erän katkennut loppukehys estää onnistumisen.
Aidosti lukemattoman putken koe ei edes alusta Noden stdin-lukua; näin
Noden oma puskurointi ei tee kokeesta näennäistä. Omistajan katoaminen
välitetään erillisellä lukijalla watchdogille. Watchdog suojaa myös profiilin
poistoa ja viimeistä raportointia; myöhemmin lauennut odottamaton syy estää
exit 0:n. Omistajakanavan katkaisu ei ole omistajaprosessin pakkotappokoe.

Broker ja lapsi käyttävät yhtä suoritinta sekä BelowNormal-prioriteettia.
Lapsen Job sallii yhden prosessin ja 512 MiB commit-muistia. Tapausrajana on
20 sekuntia, lukemattoman putken variaatiossa viisi sekuntia. Nämä ovat
koepolitiikan rajoja, eivät konekohtaisia suorituskykymittauksia tai lämpötakuita.

## Ajaminen

Projektijuuresta olemassa olevilla Windows C++ -työkaluilla:

~~~powershell
powershell -NoProfile -File tests/e2e/isolation/build-node-stdio.ps1 -DetachedMatrix
powershell -NoProfile -File tests/e2e/isolation/run-node-stdio-limited.ps1 -UnitOnly
powershell -NoProfile -File tests/e2e/isolation/run-node-stdio-limited.ps1 -DetachedMatrix
~~~

Yksittäisen kontrollin `-DetachedControlDiagnostic` ja kolmen normaalitapauksen
`-DetachedCandidate` säilyvät erillisinä rakennus-/ajovalintoina. Valintoja ei
saa yhdistää. Ilman näitä lippuja säilyy alkuperäinen CREATE_NO_WINDOW-verrokki;
sitä ei käytetä epäonnistuneen eristetyn ajon varareittinä.

Rakennus tarkistaa arkiston, paikallisen Noden ja lähteet sekä kirjoittaa
14 tulo-/tulostiedoston manifestin. Ajuri tarkistaa myös omat lähteensä ja
validaattorin ennen/jälkeen sarjan. Jokainen ajo saa uuden raporttijuuren.
Raakaviestit, ympäristötiedot, satunnaistunnisteet ja lähde-/binäärisnapshotit
säilyvät Gitistä ohitetuissa .artifacts/-hakemistoissa. Epävarmaa työtilaa ei
poisteta onnistuneen uusinnan perusteella.

## Näyttö ja rajat

Täysi 15 tapauksen sarja läpäisi:

| Tapaus | Kontrolli | AC | LPAC-ehdokas |
| --- | --- | --- | --- |
| Normaali: tiedostot, pieni/enimmäisviesti, EOF-sulku | Läpäisi | Läpäisi | Läpäisi |
| Hallittu JS-virhe | Läpäisi | Ei sarjassa | Läpäisi |
| Omistajakanavan katkaisu ready-vaiheen jälkeen | Läpäisi | Ei sarjassa | Läpäisi |
| Omistajakanavan katkaisu ennen resumea | Läpäisi | Ei sarjassa | Läpäisi |
| Kirjoitus aidosti lukemattomaan putkeen | Läpäisi | Ei sarjassa | Läpäisi |
| Nimetty varhainen käynnistysvirhe | Läpäisi | Ei sarjassa | Läpäisi |
| Virheellisen UTF-8-hyötykuorman hylkäys | Läpäisi | Ei sarjassa | Läpäisi |

Jokaisessa tapauksessa lapsi ja broker poistuivat, Job tyhjeni ja oma työtila
siivoutui. Rajoitettujen tapausten profiilit poistettiin. Ennen resumea katkaistussa tapauksessa
Node-koodia ei suoritettu. Tiedostokoetta suorittavissa kontrolleissa kaikki
kuusi tiedostotoimintoa onnistuivat. AC:ssa private-luku/-kirjoitus ja koodikirjoitus estyivät;
LPAC-ehdokkaassa myös AAP-luku estyi. Muut sallitut luku-/kirjoitustoimet
onnistuivat. Suoran LPAC-tokenkyselyn null/87/0-havainto säilyy epävarmana.

Kohdistetut 30 kevyttä testiä kattavat kehystyksen, katkenneet loppuviestit,
EOF:ää odottavan oikean Node-päätteen sekä koko kuittijärjestyksen.
Aiempi virhetulos, ylimääräinen kuitti tai puuttuva siivous ei saa peittyä
myöhemmän onnistumisen alle. Riippumaton lähde- ja raakanäyttökatselmus
vaaditaan ennen osavaiheen hyväksyntää; tarkka koonti on issuessa #10.

Verkkoyrityksiä ei tehty ja networkVerified=false. Näyttö ei vielä hyväksy
backendin todellista katalogia/tallennusta, MCP-yhteyttä, FMI-ulospääsyä,
GPU:ta, paketoitua sovellusta tai koko #10:tä. Seuraava portti on backendin
nykyisten käyttötapausten liittäminen tähän varmennettuun kuljetusmalliin.

## Lähteet

- [Windowsin prosessinluontiliput](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)
- [AttachConsole ja sen virhekoodit](https://learn.microsoft.com/en-us/windows/console/attachconsole)
- [Microsoftin konsolin käynnistyksen suunnittelukuvaus](https://github.com/microsoft/terminal/blob/main/doc/specs/%23492%20-%20Default%20Terminal/spec.md)
- [Lukittu työkaluprofiili](../../scripts/dev/toolchain.json)
