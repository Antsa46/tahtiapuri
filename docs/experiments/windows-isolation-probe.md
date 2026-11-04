# Windows-eristyksen ensimmäinen koe

T09 / #10 etenee rajatuilla porteilla. T09a / #24 on synteettinen
AppContainer/LPAC-yhteensopivuuskoe, ei koko sovelluksen oikeusrajan hyväksyntä.
Riippumaton Astra-katselmus on tehty ennen koetoteutusta.
Tämä dokumentti säilyttää alkuperäisen nollacapability-kokeen menetelmän
ja tulokset. Myöhemmän nimetyn AC-/LPAC-koematriisin
[hyväksyntänäyttö](etw-network-probe.md#synteettisen-natiivikokeen-hyväksyntänäyttö)
erottaa AC:n ETW-pudotukset ja LPAC + registryRead -profiilin suorat
socket-käyttöestot. Alkuperäisiä epäonnistumisia ei muuteta hyväksytyiksi.

## Rajaus ennen koodia

Koe sijaitsee tests/e2e/isolation/-puussa. Käynnistin ja synteettinen
koepääte ovat C++:aa; ne rakennetaan olemassa olevalla Windows x64
MSVC/Windows SDK -työkaluketjulla ja staattisella CRT:llä. Ohjelma ei tarvitse
kääntäjää havaintokäytössä. Uusia globaaleja asennuksia ei tehdä.

Käynnistin luo vain kokeen oman satunnaisnimisen AppContainer-profiilin.
Alkuperäisessä matriisissa capabilityjä ei anneta. AppContainer ja LPAC
mitataan erikseen. Paketin
koodi/aineisto saa luku- ja suoritusoikeuden, oma scratch kirjoitusoikeuden.
AppContainerin käyttöjärjestelmän luoma oma profiilitallennus huomioidaan;
väitettä vain yhdestä kirjoituspolusta ei tehdä.

Job annetaan jo CreateProcessin JOB_LIST-attribuuttina ja sulkee prosessipuun
viimeisen kahvan sulkeutuessa. HANDLE_LIST sisältää vain koepäätteen tarkoitukselliset
stdio-kahvat; Job-, token-, prosessi- ja ulkopuolisia tiedostokahvoja ei peritä.
Lapsi luodaan keskeytettynä; token, capabilityt ja Job-jäsenyys tarkistetaan
ennen sen omaa koodia. Luotettu omistaja pitää vain käynnistimen ohjausputken
kirjoituspäätä; EOF päättää omat työt myös omistajan kaatuessa.

## Näyttöportit

1. Token: todellinen AppContainer-SID, capabilityt, integrity ja Job.
2. Synteettinen aineisto: sallittu luku/kirjoitus sekä estetty ulkopuolinen
   luku/kirjoitus ja paketin muuttaminen. Verkkokokeissa on toimiva suojaamaton
   verrokki; timeout ei tarkoita OS-estoa. Lapsiprosessin perimä raja ja
   käynnistimen/omistajan menetys todennetaan.
3. Electron Node -tila ja SDK:n natiivibinääri erillisellä koeadapterilla.
   Nykyinen model-worker tarvitsee parentPortin eikä toimi stdiolla sellaisenaan.
4. Hyväksytty 4B CPU, sitten CUDA: lataus, generointi, peruutus, virhe ja sulku.

T09a kattaa portit 1–2. Portit 3–4 ja roolikohtainen desktop/backend/MCP-minipaketti
ovat riippuvaisia jatkotöitä. Nykyinen node-llama-cpp käynnistää binäärikokeessa
lapsiprosessin; lapsikieltoa ei lisätä oletuksena sen toimivuutta todistamatta.

## Turvarajat ja tulosten käsittely

Koe muuttaa vain omaa staged-koepuutaan ja uniikkia omaa AppContainer-profiilia.
Repositoryyn, kotihakemistoon tai koko mallikirjastoon ei anneta ACL-granttia.
Palomuurisääntöjä, loopback-poikkeuksia, järjestelmän DNS:ää tai käyttäjän
oikeuksia ei muuteta. Paketointi ei käytä lähteen kanssa jaettuja hardlinkkejä.
Koetulokset ja tarkat SID-/PID-/laite-/polkutiedot jäävät .artifacts/tests/-puuhun;
julkiseen raporttiin tulevat vain koemenetelmä ja rajatut tulokset.

T09:n mahdollinen luotettu FMI-broker voisi toteuttaa valvotun verkkovälityksen.
Se ei yksin todista brokerin oman OS-FQDN-sallittulistan olemassaoloa.
Varsinaisen sään verkkokoetta ei avata tämän synteettisen vaiheen perusteella.
AC/LPAC:n toimivuus, GPU-yhteensopivuus ja täyden minipaketin oikeudet ovat
kokeella selvitettäviä, eivät tämän suunnitelman perusteella hyväksyttyjä.

## Lähteet

- [Microsoft: AppContainer ja LPAC](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
- [Microsoft: prosessiattribuutit](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- [Microsoft: Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Microsoft: tokenkyselyjen luokat](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class)
- [Microsoft: olemassa olevien WFP-tapahtumien ja pudotusten diagnostiikka](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/troubleshooting-uwp-firewall)
- [Microsoft: sovelluskohtainen profiili](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile)

Tila: synteettinen koetoteutus; osatulokset kirjataan alla. T09a ja T09
eivät ole tällä näytöllä hyväksyttyjä sovelluksen OS-eristykseksi.

## Koetoteutus ja toistaminen

Aja projektijuuresta Windows PowerShellissä:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\e2e\isolation\run.ps1
```

Ajuri ei asenna työkaluja. Se tarvitsee projektin jo valmistellun lukitun
Windows Node -runtimen sekä olemassa olevan x64 MSVC C++17- ja Windows SDK
-työkaluketjun. Pelkkä käännös tehdään build.ps1:llä; run.ps1:n SkipBuild
soveltuu vain, kun nykyinen lähde on jo käännetty. Tuotokset jäävät
.artifacts/tests/isolation/-puuhun. Testihost ei ole tuotantokäynnistin:
sen CLI vastaanottaa vain luotetun testiajurin itse luomat polut.
Marker-tiedosto rajaa virheitä, eikä ole epäluotetun kutsujan valtuutusmekanismi.

Alkuperäisen kymmenen tapauksen matriisi sisältää tavallisen verrokin,
tarkoituksella perityn sentinel-kahvan verrokin sekä AC:n ja LPAC:n
normaalin ajon, koepäätteen virheen, käynnistimen pakotetun päättymisen
ja omistajan pakotetun päättymisen. Jos LPAC:n normaali jälkeläiskäynnistys
epäonnistuu tunnetulla koodilla 5 mutta sen nimetyt pääprosessirajat ja
siivous toimivat, tapaus säilyy epäonnistuneena. Kolme muuta alkuperäistä
LPAC-jälkeläistapausta jäävät ajamatta; niiden sijaan ajetaan neljä
erikseen nimettyä primary-tapausta vain pääprosessin diagnostiikkana.
Näitä ei lasketa alkuperäisten hyväksymisehtojen täyttymiseksi.
Virhekoe odottaa jälkeläisen mittausten valmistumista omalla scratch-merkillä;
kiinteää ajallista arvausta ei käytetä. Kahvan periytymisen tarkistaa host
DuplicateHandlella ennen ResumeThreadiä ja vertaa tiedostoidentiteettiä.
Jälkeläisellä on oma eksplisiittinen stdio-HANDLE_LIST; sille ei väitetä
tehdyksi erillistä sentinel-kahvojen mittausta.

Koodi ja koepainot ovat eri read-only-fixtureja. legacy.fixture saa vain
käyttäjän/SYSTEMin sekä ALL_APPLICATION_PACKAGESin grantin, ei paketti-SID:tä.
Ajuri lukee suojatut DACL:t takaisin ja vertaa ACEt asetettuun politiikkaan.
AC:n onnistunutta legacy-lukua verrataan LPAC:n koodin 5 estoon, samalla kun
molempien paketti-SID:llä sallittu aineisto toimii.

Tokenin LPAC-kysely, pyydetty käynnistyspolitiikka ja legacy-fixturen
käyttäytyminen raportoidaan erillisinä. Epäonnistunut TokenIsLessPrivilegedAppContainer
-kysely on null ja raaka virhekoodi/pituus, ei false eikä käyttäytymiskokeesta
päätelty true. Testi ei kierrä käyttäjätilan rajaa dokumentoimattomalla
natiivikyselyllä. Tämä tulos ei riitä tuotantokäynnistyksen LPAC-takuuksi.

Verkkokokeet kattavat vain IPv4/IPv6 TCP/UDP-loopbackin ja toimivat
suojaamattomat echo-verrokit. WSAEACCES 10013 on suora käyttöestotulos;
WSAETIMEDOUT 10060 jää epäselväksi, vaikka echo-palvelin ei vastaanota
sovellusdataa eikä hyväksy TCP-yhteyttä. Laskurit erotetaan toisistaan.
Jos Winsockin alustus epäonnistuu, yhteysoperaatiot ovat attempted=false ja
network-startup-virhe kirjataan; tätä ei pidetä toteutettuna verkkokokeena.
Tällöin corePassed voi olla true tiedosto-/prosessi-/elinkaariehdoille,
mutta networkVerified ja koko kokeen passed ovat false. Kokonaisajon exit
on 1, joten puuttuvaa verkkonäyttöä ei voi sekoittaa läpäisyyn.
Ulkoinen verkko, DNS, proxy ja täydellinen OS-verkkopolitiikka jäävät
jatkoportteihin. Windowsin nykyisten WFP-tapahtumien luku voi edellyttää
ylläpito-oikeutta; koe ei ota oikeutta tai muuta auditointi-/palomuuripolitiikkaa.

Normaalisiivous ja virhesiivous odottavat Jobin tyhjenemistä. Ajurin
odotuksilla on aikarajat; tarvittaessa emergency-helper tarkistaa PID:n
suoritettavan kuvan juuri tämän uniikin staged-puun omaksi ennen terminointia.
Emergency-siivoamisen tarve hylkää elinkaaritapauksen. Profiili poistetaan
vain oman luonnin kuittia vasten ja todetun prosessipäättymisen jälkeen.
Myös epäonnistuneen tapauksen staged-aineisto poistetaan onnistuneen
siivouksen jälkeen; epävarma siivous säilyttää kuitin ja aineiston sekä
näkyvän virheraportin. Profiilin luonnin ja kuitin kirjoituksen väli ei ole
käyttöjärjestelmän transaktio; mielivaltaista käynnistimen kaatumista juuri
siinä välissä ei väitetä ratkaistuksi. Tuotantokäyttö vaatii oman palautusmallinsa.

## Mitattu osatulos

Rajattu natiivimatriisi ajettiin 3.11.2026. Lopputulos on **ei hyväksytty**:
passed=false, corePassed=false ja exit 1. Toteutunut näyttö:

| Tapaus | Tulos ja näyttöraja |
| --- | --- |
| Tavallinen verrokki ja sentinel-grantin verrokki | 2/2 onnistuivat; tiedostomuutokset ja kaikki neljä echo-protokollaa toimivat. |
| AC:n normaali ajo, virhe, launcher-kill ja owner-kill | 4/4 tuottivat nimetyn tiedosto-, identiteetti-, Job- ja prosessipuusiivouksen näytön; verkkoraja jäi avoimeksi. |
| LPAC:n alkuperäinen normaali jälkeläistapaus | Epäonnistui: WSAStartup 10107, jälkeläisen CreateProcessW 5. Jälkeläistä ei syntynyt. |
| LPAC:n alkuperäiset jälkeläisen virhe-/launcher-kill-/owner-kill-tapaukset | 3 ajamatta alkuperäisen käynnistyksen epäonnistumisen vuoksi. |
| LPAC:n erilliset primary-normal/error/launcher-kill/owner-kill-diagnoosit | 4/4 pääprosessin nimettyä tiedosto-/identiteetti- ja elinkaaridiagnoosia toimivat; eivät korvaa jälkeläistapauksia. |
| Siivous | Kaikkien 11 toteutuneen tapauksen omat prosessit, profiilisiivous ja staged-puut varmistettiin. Emergency-terminointia ei tarvittu. |

Todelliset AppContainer-SID:t, nollacapabilityt, Low Integrity ja Job-jäsenyys
mitattiin käynnistimessä sekä koepäätteissä. LPAC:n suora tokenkysely
palautti 87; sen totuusarvo jäi nulliksi. legacy-fixturen luku onnistui AC:ssa
ja estyi LPAC-pääprosesseissa koodilla 5. Sallittu aineiston luku sekä oma
scratch-kirjoitus toimivat; ulkopuolinen synteettinen luku/kirjoitus sekä
paketin malliaineiston ja moduulitiedoston muuttaminen estyivät koodilla 5.

AC:n 32 yhteysoperaatiota päätyivät timeoutiin 10060; echo-palvelimet eivät
hyväksyneet AC:n TCP-yhteyksiä eivätkä vastaanottaneet sen sovellusdataa.
Tätä ei hyväksytty OS-eston todisteeksi. LPAC:n verkkoyritykset jäivät
Winsock-alustuksen virheen vuoksi tekemättä. Nykyisten WFP-tapahtumien
read-only-luku ei onnistunut ilman ylläpito-oikeuksia (5); oikeuksia ei nostettu.
Näistä ei päätellä yleistä LPAC-lapsikieltoa tai kaikkia Winsockin virheen syitä.

Myöhempi [Electron-koe](electron-isolation-probe.md) ja
[korjatun Node-/SDK-polun vertailu](runtime-comparison.md) ovat tuottaneet
rajattua AC-yhteensopivuusnäyttöä. Oikea GGUF-/GPU-ajo, verkkoraja ja koko
sovelluksen eristys ovat edelleen erillisiä portteja. Tämä testihost ei muuta
sovelluksen UtilityProcess-ajotapaa, avaa sääverkkoa tai valitse tuotantoon
AC-/LPAC-politiikkaa.

## Verkkodiagnostiikan jatkokoe

Natiivikoepääte täydentää socket-kokeen tulosta erillisellä
`network-detail`-rivillä: prosessin rooli ja PID, protokolla, osoitteet, portit,
UTC-aikaväli, viimeinen vaihe ja alkuperäinen tuloskoodi. Oma kahden sekunnin
`select`-odotusraja on `connect-deadline`; sitä ei esitetä Winsockin palauttamana
estovirheenä. `getsockname`-diagnostiikka ei korvaa aiempaa virhekoodia.
Socket-asetusten tai tilanvaihdon virhe voi keskeyttää kokeen ennen lisäriviä;
silloin native-virhe säilyy ja metatietonäyttö puuttuu. Alustamatta jääneelle
Winsockille ei synny tekaistua yhteysyritystä.

Luotettu käynnistin tallentaa natiivipolulla ennen käynnistystä Windowsin
`FwpmGetAppIdFromFileName0`-tunnisteen heksamuodossa. Ajuri säilyttää myös
staged-koebinäärin SHA-256:n, kohdeportit ja ajankohdat. Varsinaiset polut,
SID:t, PID:t ja raakadata jäävät ohitettuihin paikallisiin artefakteihin.
Uudelleen käännetyn hostin tarkiste tallennetaan ajon yhteyteen; aiempien
SDK-kokeiden host-tarkisteet kuvaavat niiden omia binäärejä.

Uusinnassa kaikki 11 siivousta onnistuivat ilman hätäsiivousta. Kontrollien
16 echo-vastausta toimivat. AC:n 32 yrityksestä 16 TCP-yritystä päätyi omaan
`connect-deadline`-rajaan ja 16 UDP-yritystä `receive`-vaiheen aikakatkaisuun.
AC:n TCP-lähdeosoite jäi socket-kyselyssä arvoon `0.0.0.0` tai `::`; se ei
ole mitattu loopback-lähdeosoite eikä sitä korvata jälkikäteen oletuksella.
LPAC:n viidessä pääprosessikokeessa yhteensä 20 verkkotoimintoa jäi tekemättä
alustusvirheen 10107 vuoksi. Aiemmat LPAC-lapsen luonti- ja tokenkyselyhavainnot
säilyivät. Koko matriisi jäi hylätyksi (`passed=false`, exit 1).

Olemassa olevia WFP-tapahtumia luettiin käyttäjän hyväksymässä erillisessä
kokeessa ylläpito-oikeuksilla. Vain lukija käytti näitä oikeuksia;
koeprosessit ajettiin tavallisella käyttäjäoikeudella. Kahdeksan kiinteää
`netsh wfp show netevents` -hakua rajattiin AC:n normaalin pääprosessin ja
jälkeläisen loopback-kohteisiin, protokolliin, lähde-/kohdeportteihin ja
viimeiseen tuntiin. Kaikki lukukomennot onnistuivat, mutta kaikissa XML-
tuloksissa oli nolla tapahtumaa. Palomuuri-, loopback-, capability- tai
lokikeruuasetuksia ei muutettu. Tyhjä rajattu hakutulos ei osoita sallimista
eikä estoa; myöskään puuttuvan tapahtuman syytä ei tällä kokeella ratkaistu.

Tämä lisädiagnostiikka ei muuta `networkVerified`-hyväksyntää. Jatkon
verkkonäyttö tarvitsee rajatun tapahtumahavainnoinnin sekä toimivan kontrollin.
Alla kuvattu suora tilaus on toteutettu tämän ensimmäiseksi osaksi. Tapahtuma pitää yhdistää täsmälliseen
ajoon, appId:hen, paketti-SID:hen, liikenteeseen ja aikaan. Puuttuvat kentät,
TCP:n tuntematon lähdeosoite tai ristiriitainen echo-näyttö jäävät avoimiksi.
WFP-pudotus ja nimenomaan AppContainer-säännön aiheuttama pudotus erotetaan:
jälkimmäinen vaatii myös pudottavan suodattimen alkuperän tarkistamisen.

Menetelmän tausta: [Microsoftin WFP-vianrajaus](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/troubleshooting-uwp-firewall),
[netsh wfp](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/netsh-wfp)
ja [ohjelmatunnisteen haku](https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmgetappidfromfilename0).


## Suora WFP-tapahtumatilaus

`run.ps1 -Probe network` käynnistää erillisen lyhyen kehityskokeen.
Se käyttää samoja neljää paikallista TCP-/UDP-päätepistettä IPv4:llä ja
IPv6:lla järjestyksessä tavallinen kontrolli, AC:n normaali ajo ja
jälkikontrolli. `network-once` sitoo lähdeosoitteen nimenomaisesti loopbackiin
ennen yhteysyritystä sekä pääprosessissa että jälkeläisessä. Kyse on erillisestä
variaatiosta; vanhat wildcard-havainnot tai alkuperäinen matriisi eivät muutu.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\e2e\isolation\run.ps1 -Probe network
```

Vain kiinteä `wfp-observer.exe` pyytää Windowsin korotusvahvistuksen.
Koepäätteiden kontrollit varmistetaan tavalliselle Medium Integrity -tasolle.
Lukija ei käynnistä koepäätteitä tai muita ohjelmia, muuta keruuasetuksia,
lisää palomuurisääntöjä tai myönnä capabilityjä. Jos tapahtumakeruu on pois
päältä, AC-koe ei käynnisty; sitä edeltävä tavallinen kontrolli ehtii ajaa.
Havaintokäytön sovellus ei tarvitse tätä kehityslukijaa tai korotusoikeutta.

Lukija avaa oman dynaamisen WFP-session ja `FwpmNetEventSubscribe1`-tilauksen.
Tilaus rajataan tarkkaan staged-koebinäärin appId:hen ja aikaikkunaan;
callback tarkistaa appId:n vielä uudelleen. Verkkoyritykset alkavat vasta
valmiuskuittauksen jälkeen. Callback kopioi rajatut tapahtumat jonoon;
mahdollinen `CLASSIFY_DROP`-suodatin luetaan ajon aikana erikseen
`FwpmFilterGetById0`-kutsulla. Osoitteiden ja muun metatiedon olemassaololiput
säilyvät. WFP:n HEADER2 ei anna PID:tä, joten PID kuuluu vain koepäätteen
omaan tulokseen. Kaikkia suodatinehtojen arvotyyppejä ei ole vielä tulkittu;
tuntematon tyyppi merkitään puuttuvaksi näytöksi.

Lukijan rajat ovat 256 tapahtumaa, 8 MiB tapahtumatiedosto, 45 sekunnin
havaintoikkuna ja 60 sekunnin oma prosessivahti. Seuraavaan vaiheeseen ei
siirrytä keskeytyneen keruun perusteella. Normaali sulku peruu vain oman
tilauksen ja sulkee oman engine-session. Omistajaprosessin päättyminen
lopettaa odotuksen. Prosessivahti voi lopettaa oman lukijan, jolloin Windows
sulkee sen WFP-session; tämä poikkeus ei tuota hyväksyttyä loppukuittia.
Kaatumissiivouksen API-perusta ei korvaa erikseen mitattua kaatumiskoetta.

Tapahtumatiedosto ja kuitit syntyvät uuteen paikalliseen `wfp/`-hakemistoon,
jonka suojattu DACL antaa pääsyn nykyiselle käyttäjälle ja SYSTEMille.
Reparse-polut torjutaan. Koe on luotetun kehitysajurin käyttöön; run-tunniste,
merkkitiedosto tai CLI eivät ole epäluotetun kutsujan valtuutusrajapinta.
Raakadata, SID:t, polut ja paikalliset ajotunnisteet eivät kuulu julkaisuun.

Ajuri hyväksyy keruun valmistumisen vasta, kun prosessin exit-koodi,
`done.json`, järjestyksessä olevat baseline/ready/finished-tietueet,
appId:n vastaavuus, tapahtumamäärä, tilauksen sulku sekä todelliset alku- ja
loppuasetukset täsmäävät. Pelkkä nollapoistumiskoodi ei riitä.
`observation.complete` ei koskaan yksin muuta `networkVerified`-arvoa.
Myös ennen connectia tapahtuva bind-esto raportoidaan erikseen.

### Mitattu rajattu tulos

- Natiivikäännös läpäisi `/W4 /WX`-tarkistukset olemassa olevalla työkaluketjulla.
  Tavallisilla oikeuksilla tehty lukijan virhekoe palautti lukuoikeusvirheen,
  ei ready-kuittia ja epäonnistuneen loppukuitin; prosessi poistui.
- Loppukuittauksen 14 kohdistettua testiä läpäisivät. Ne torjuvat muun muassa
  puuttuvan tai kahdentuneen kuitin, väärän ohjelmatunnisteen, ilmoitetun tapahtumamäärän
  ristiriidan sekä muuttuneet asetukset, vaikka raportti väittäisi niitä samoiksi.
- Alkuperäisen 11 tapauksen uusinnassa kaikki omat siivoukset onnistuivat;
  aikaisemmat verkkonäytön ja LPAC-yhteensopivuuden puutteet säilyivät.
- Lyhyen havaintokokeen kolmessa tapauksessa kaikki koepääteprosessit,
  omat profiilit ja staged-aineisto siivoutuivat. Kontrollit saivat yhteensä
  16 echo-vastausta samoilta päätepisteiltä ennen AC-ajoa ja sen jälkeen.
- AC:n kahdeksan yritystä päätyivät edelleen aikarajaan. Tässä variaatiossa
  kaikille saatiin todellinen loopback-lähdeosoite ja portti.
- Korotettu tilaus avautui ja sulkeutui onnistuneesti. Yleinen tapahtumakeruu
  oli päällä; alku- ja loppuasetukset täsmäsivät. Tapahtumia saatiin **nolla**.
  Todellisen pudotustapahtuman toimitus, suodattimen lukupolku ja tapahtuman
  yhdistäminen liikenteeseen eivät siksi vielä saaneet ajonaikaista näyttöä.

Koko verkkonäyttö pysyy avoimena. Windows SDK erottaa muun muassa
`CAPABILITY_DROP`-, `CAPABILITY_ALLOW`- ja `CLASSIFY_ALLOW`-keruubitit;
niitä ei ollut valittu tässä kokeessa. Tarvittavan tapahtumalajin puuttuminen
on jatkohypoteesi, ei osoitettu selitys tyhjälle tulokselle tai aikakatkaisulle.
WFP-tilaus ei tarjoa omaa tapahtumalajien generointimaskia. Engine-asetuksen
muutos olisi globaali ja säilyisi uudelleenkäynnistyksen yli, joten sitä ei
sisällytetä automaattisesti tähän vain lukevaan kokeeseen. Mahdollinen jatko
vaatii erikseen rajatun muutoksen, palautus- ja keskeytyssuunnitelman sekä
käyttäjän hyväksynnän. Mitään näistä globaaleista asetuksista ei tässä muutettu.

Mahdollinen `CAPABILITY_DROP`-jatkokoe tarvitsee myös oman payloadin
tulkinnan: nykyinen lukija poimii suodatintunnisteen vain `CLASSIFY_DROP`-
tapahtumasta. Oman ETW-session tarjoama tapahtumavalinta on vaihtoehtoinen
selvityshaara. Sen provider-kohtaisia maskeja ei voi päätellä WFP:n biteistä,
eikä capability-tapahtumien toimitusta tätä kautta ole vielä osoitettu.

API-perusta: [Subscribe1](https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmneteventsubscribe1),
[HEADER2](https://learn.microsoft.com/en-us/windows/win32/api/fwpmtypes/ns-fwpmtypes-fwpm_net_event_header2),
[tilauksen peruminen](https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmneteventunsubscribe0)
ja [engine-asetusten pysyvyys](https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmenginesetoption0).

Oman ETW-istunnon seuraava rajattu koe ja sen siivousvahti kuvataan
[ETW-verkkokokeessa](etw-network-probe.md). Se ei muuta tämän kokeen tulosta.


LPAC:n lapsenluonnin ja Winsock-alustuksen myöhempi erotettu diagnoosi
kuvataan [käynnistyskokeessa](lpac-startup-probe.md). Sen 12 mitattua tapausta
rajasivat virheen selityksiä, mutta LPAC:n virheet 5 ja 10107 säilyivät.
Tämä ei muuta alkuperäisen matriisin tulosta.
