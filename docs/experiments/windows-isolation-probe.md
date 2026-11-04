# Windows-eristyksen ensimmäinen koe

T09 / #10 etenee rajatuilla porteilla. T09a / #24 on synteettinen
AppContainer/LPAC-yhteensopivuuskoe, ei koko sovelluksen oikeusrajan hyväksyntä.
Riippumaton Astra-katselmus on tehty ennen koetoteutusta.

## Rajaus ennen koodia

Koe sijaitsee tests/e2e/isolation/-puussa. Käynnistin ja synteettinen
koepääte ovat C++:aa; ne rakennetaan olemassa olevalla Windows x64
MSVC/Windows SDK -työkaluketjulla ja staattisella CRT:llä. Ohjelma ei tarvitse
kääntäjää havaintokäytössä. Uusia globaaleja asennuksia ei tehdä.

Käynnistin luo vain kokeen oman satunnaisnimisen AppContainer-profiilin.
Capabilityjä ei anneta. AppContainer ja LPAC mitataan erikseen. Paketin
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

Tämä lisädiagnostiikka ei muuta `networkVerified`-hyväksyntää. Seuraava
verkkonäyttö tarvitsee erikseen suunnitellun ja hyväksytyn rajatun tapahtuma-
tallennuksen sekä toimivan kontrollin. Tapahtuma pitää yhdistää täsmälliseen
ajoon, appId:hen, paketti-SID:hen, liikenteeseen ja aikaan. Puuttuvat kentät,
TCP:n tuntematon lähdeosoite tai ristiriitainen echo-näyttö jäävät avoimiksi.
WFP-pudotus ja nimenomaan AppContainer-säännön aiheuttama pudotus erotetaan:
jälkimmäinen vaatii myös pudottavan suodattimen alkuperän tarkistamisen.

Menetelmän tausta: [Microsoftin WFP-vianrajaus](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/troubleshooting-uwp-firewall),
[netsh wfp](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/netsh-wfp)
ja [ohjelmatunnisteen haku](https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmgetappidfromfilename0).
