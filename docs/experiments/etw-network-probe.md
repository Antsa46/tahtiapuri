# Lyhyt ETW-verkkokoe

Tila: toimiva rajattu tapahtumakeruu ja automaattinen vastaavuuden tarkistus.
Windowsin loopback-pudotukset saatiin näkyviin ilman pysyviä asetusmuutoksia.
Automaation näyttö erotetaan alla alkuperäisestä manuaalisesta kokeesta.
Tämä ei vielä hyväksy sovelluksen koko verkkorajaa.
Edeltävän [WFP-tilauksen](windows-isolation-probe.md#suora-wfp-tapahtumatilaus)
tyhjä tulos jätti eston syyn avoimeksi. Tässä kokeillaan erillistä Windowsin
ETW-tapahtumareittiä muuttamatta pysyviä keruu- tai palomuuriasetuksia.

## Menetelmä

Windowsin paikallisesta Microsoft-Windows-WFP-tapahtumakuvauksesta löytyi
pudotustapahtuma 1001, versiot 0–2, ja `ut:Dropped`-valinta. Tämä ETW-valinta
on eri asia kuin WFP-enginen capability-keruubitit. Tapahtuma 1029 jätetään
pois, koska siitä puuttuu tämän kokeen tarvitsema ohjelmatunniste.

`run.ps1 -Probe etw` käyttää samaa erillistä loopback-variaatiota kuin
WFP-tilauskoe: tavallinen kontrolli, AC:n normaali ajo ja jälkikontrolli
samoilla neljällä IPv4-/IPv6-/TCP-/UDP-päätepisteellä. Lähdeosoite sidotaan
loopbackiin. Se ei korvaa alkuperäisen matriisin tapauksia.

Vain `etw-observer.exe` ja sen samasta binääristä käynnistetty siivousvahti
saavat Windowsin korotusvahvistuksen kautta ylläpito-oikeudet. Koepäätteet
pysyvät entisessä suojauskontekstissaan; kontrollien Medium Integrity
tarkistetaan. Kerääjä ei käynnistä koepäätteitä.

Kerääjä avaa satunnaisella nimellä ja GUID:llä oman ETW-istunnon. Se tilaa
vain tapahtuman 1001, käyttää reaaliaikaista kuluttajaa ja suodattaa tarkasti valitun
koeohjelman tai omistavan testipalvelimen AppId:n ennen lokikirjoitusta. Hyväksytyt NT- ja
DOS-polut muodostetaan etukäteen samasta kiinteästä koetiedostosta.
Vertailu kattaa koko tunnisteen; sisäiset NUL-merkit hylätään.
Testipalvelimen polku luetaan avatusta owner-prosessikahvasta ja verrataan
ajurin käyttämään tunnettuun Node-binääriin ennen keruun aloittamista.
Molempien socket-osoitteiden on oltava täsmälliset IPv4- tai IPv6-loopback-
osoitteet. Koeohjelman tapahtumassa etäpään, palvelimen tapahtumassa
paikallisen pään portin on vastattava saman ajon kuuntelevaa päätepistettä.
Tarkistukset tehdään ennen tapahtuman jonotusta ja lokikirjoitusta. ETL-tiedostoa ei synny.
Windowsin puskureihin ja kerääjän muistiin voi hetkellisesti tulla muidenkin
sovellusten samanlajisia tapahtumia. Niitä ei kirjoiteta kokeen raporttiin.
Tämä on luotetun kehitysajurin rajattu koe, ei julkinen valtuutusrajapinta.

Rajaukset:

- Ei `FwpmEngineSetOption`-kutsua, palomuurisääntöjä, auditointimuutoksia,
  AutoLoggeria, rekisterimuutoksia tai loopback-poikkeuksia.
- Oma istunto käyttää 32 KiB:n puskureita ja pyytää neljä puskuria sekä
  `EVENT_TRACE_NO_PER_PROCESSOR_BUFFERING`-lipun. Toteutuneet arvot kirjataan.
- Enintään 4 096 vastaanotettua ja 256 säilytettyä tapahtumaa, 64 KiB
  yksittäiselle TDH-kentälle, 8 MiB paikalliselle tapahtumalokille.
- Normaali havaintoikkuna enintään 45 sekuntia. Erillisen vahdin takaraja
  on 60 sekuntia; se varmistaa kiinteän kontrollibinäärin identiteetin ennen
  oman jumittuneen kontrollinsa päättämistä.
- Oma tuloshakemisto antaa pääsyn nykyiselle käyttäjälle ja SYSTEMille.
  Raakadata, SID:t, polut ja ajotunnisteet jäävät Gitistä ohitettuihin tiedostoihin.

## Elinkaari ja poikkeukset

Siivousvahti avaa kontrollin prosessikahvan ja kuittaa valmiuden ennen
ETW-istunnon aloitusta. Se tarkistaa, ettei samannimistä istuntoa jo ole.
Myös kontrolli seuraa vahdin poistumista. Vahti toimii erillään kontrollin
elinkaaresta ja pystyy sulkemaan oman istunnon kontrollin kaaduttua.

Normaalissa lopetuksessa provider poistetaan omasta istunnosta, istunto
pysäytetään ja kuluttaja odotetaan loppuun. Vahti tekee vielä jälkitarkistuksen.
Poissaoloksi hyväksytään vain `ERROR_WMI_INSTANCE_NOT_FOUND`. Vierasta
GUID:tä tai yleistä kyselyvirhettä ei tulkita onnistuneeksi siivoukseksi.

ETW-istunto ei automaattisesti lopu sen aloittaneen prosessin mukana.
Molempien valvontaprosessien yhtäaikaisen pakkopäättymisen varalle säilytetään
paikallinen ajotunniste jälkitarkistusta varten. Koe ei lupaa automaattista
siivousta tilanteessa, jossa molemmat siivouksen toteuttajat tapetaan.

Kuittaus tarkistaa kontrollin ja vahdin exit-koodit, istunnon poissaolon,
kuluttajan päättymisen, tapahtuma-/puskurihävikin, callback-virheet sekä
WFP-enginen alku- ja loppuasetusten vastaavuuden. Keskeytynyt tai hävikillinen
keruu ei kelpaa hyväksytyksi havainnoksi. Tyhjä onnistunut keruu ei osoita estoa.
Tulkintavirheestä säilytetään ensimmäinen virhevaihe, versio ja virhekoodi
johdonmukaisena kokonaisuutena. Vain jo oman AppId- ja endpoint-rajauksen
läpäisseen tapahtuman rajattu raakasisältö voi jäädä paikalliseen virhekuittiin
myöhempää offline-tulkintaa varten; sitä ei siirretä julkisiin fixtureihin.

## Näytön tulkinta

Aikavertailussa käytetään ETW-otsakkeen `TimeStamp`-kenttää. `ProcessTrace`
muuntaa sen oletuksena järjestelmäajaksi; kokeessa ei käytetä
`PROCESS_TRACE_MODE_RAW_TIMESTAMP`-lippua. Payloadin samanniminen kenttä
säilyy erillisenä `payloadTimestampRaw`-arvona: omassa versio 2 -koetietueessa
se oli nolla, eikä sitä voinut tulkita UTC-ajaksi. Ajan lähde merkitään
`timeSource`-kenttään. [Microsoftin aikaleimasopimus](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/ns-evntrace-event_trace_logfilew)

Tapahtuma 1001 sisältää AppId:n, paikallisen ja etäpään socket-osoitteet,
loopback-lipun sekä FilterId:n ja LayerId:n. Suodattimen tiedot luetaan
mahdollisimman pian erillisellä vain lukevalla WFP-kutsulla. Tuntematon tai
jo poistunut suodatin jää puuttuvaksi näytöksi.

`observedAppIdHex` säilyttää tapahtuman alkuperäisen AppId:n.
`canonicalAppIdHex` on hyväksytyn koetiedoston WFP-rajapinnasta saatu johdettu
tunniste, ja `appIdMatch` kertoo täsmänneen esitysmuodon. `identityRole`
erottaa koeohjelman (`probe`) ja testipalvelimen (`endpoint-owner`).
Palvelimen osumaa ei nimetä koeohjelman suoraksi tunnistehavainnoksi. Hylätyistä
tietueista säilytetään vain lukumäärät. Luokkien summan tulee vastata
kaikkia vastaanotettuja tietueita; callback-luku ei yksin tarkoita
WFP-pudotustapahtumien määrää.

Tapahtumassa **ei ole IP-protokollaa eikä AppContainerin paketti-SID:tä**.
`UserSID` on käyttäjän SID. ETW-otsakkeen PID kuvaa tapahtuman tuottajaa,
ei luotettavasti estettyä ohjelmaa. Protokollan ja paketti-identiteetin
mahdollinen yhdistäminen perustuu oman ajurin tietoihin, uniikkiin staged-
polkuun, aikaan ja osoitteisiin; niitä ei nimetä tapahtumasta luetuiksi.

Yksi pudotustapahtuma ei todista kaikkia verkkotapauksia. Pelkkä tapahtuman
vastaanotto ei muuta `networkVerified`-arvoa. Tapahtumien vastaavuus omiin
yrityksiin ja pudottavan suodattimen alkuperä arvioidaan erikseen.

## Ensimmäisen keruun paikallinen tarkistus

Ennen AC-koetta suoritetaan tyhjän istunnon normaali sulku ja kontrollin
pakotetun päättymisen koe. Molemmista vaaditaan oman istunnon poissaolon
kuittaus. Paikalliset tarkistukset:

- Pieni natiivikäännös läpäisi `/W4 /WX`-tarkistukset.
- WFP- ja ETW-kuittausten yhteensä 32 testiä sekä muutettujen PowerShell-
  ja JavaScript-tiedostojen syntaksitarkistukset läpäisivät. Lisäksi 13
  puhdasta natiivia osoitetarkistusta todensi portin puolen, loopback-rajauksen,
  perheiden eron ja socket-aineiston tulkinnan ilman tapahtumakeruuta.
- Tyhjä istunto sulkeutui normaalisti. Kerääjän tarkoituksellinen
  päättyminen poistumiskoodiin 123 jätti loppukuitin puuttumaan odotetusti,
  mutta erillinen vahti todensi oman istunnon poissaolon.
  Molempien selftestien staged-aineisto poistui.
- Näissä kokeissa toteutui pyydetty 32 KiB × 4 puskuria. Vahdin 60 sekunnin
  aikakatkaisupolkua tai molempien prosessien yhtäaikaista tappoa ei testattu.

Lopullisessa verkkokokeessa:

- Kontrollit saivat yhteensä 16 echo-vastausta samoista neljästä päätepisteestä
  ennen AC-ajoa ja sen jälkeen. Kaikki kolme koetapausta siivoutuivat.
- Keruu hyväksyi 12 tapahtumaa, kaikki versio 2 ja rooli `endpoint-owner`.
  Jokainen täsmäsi osoitteiden, molempien porttien ja ETW-otsakeajan perusteella
  yksikäsitteisesti yhteen AC:n omaan raportoituun verkkoyritykseen.
- Näyttö kattoi kahdeksan yritystä: pääprosessi ja jälkeläinen, kummallakin
  TCP/UDP ja IPv4/IPv6. Jokaiselle TCP-yritykselle tuli kaksi pudotustapahtumaa,
  jokaiselle UDP-yritykselle yksi. Tapahtuma tunnisti vastaanottavan
  testipalvelimen, ei suoraan AppContainer-koepäätettä.
- Kaikki pudottavien suodattimien lukukyselyt onnistuivat. SDK-tunnisteisiin
  verrattuna kerrokset olivat `ALE_AUTH_RECV_ACCEPT_V4/V6`, provider
  `MPSSVC_WF` ja alikerros `MPSSVC_APP_ISOLATION`. Toiminto oli
  `FWP_ACTION_BLOCK`. Ehdoissa olivat `IS_LOOPBACK`-lippu ja `ALE_USER_ID`-
  suojauskuvaaja. Päätelmä ei perustu pelkkään suodattimen näyttönimeen.
- Sekä kerääjä että vahti päättyivät onnistuneesti. Istunto todettiin
  poistuneeksi, hävikit ja callback-virheet olivat nolla ja WFP-enginen
  alku- ja loppuasetukset täsmäsivät. Globaaleja asetuksia ei kirjoitettu.

Tämä on manuaalisesti tarkistettu näyttö juuri tämän loopback-variaation
Windows-pudotuksista. Protokolla ja paketti-identiteetti tulevat oman ajurin
korrelaatiosta; tapahtuma ei anna niitä suoraan. Suojauskuvaajan jokaisen
ACE:n käyttöoikeuslaskentaa ei toistettu. Koko sovelluksen ulkoista verkkoa,
DNS:ää, LPAC-yhteensopivuutta tai mallin CPU/GPU-kokoonpanoa ei hyväksytä
näillä tapahtumilla.

Ensimmäisessä tallennetussa ajossa automaattinen `networkVerified` jäi
epätodeksi ja kokonaisajon exit oli 1: automaattista aika-/portti-/
suodatintulkinnan hyväksyntää ei tuolloin ollut. Näitä alkuperäisiä tuloksia
ei kirjoiteta jälkikäteen uudelleen. Alkuperäistä 11 tapauksen matriisia ei ajettu tässä vaiheessa
uudelleen. Alkuperäiset WFP-apufunktiot vain siirrettiin yhteiseen otsakkeeseen;
niiden sisällön muuttumattomuus tarkistettiin lähdevertailulla.

Aikaisemmat keruut säilyvät omilla tuloksillaan: kaksi ensimmäistä eivät
löytäneet hyväksyttyä koeohjelman tunnistetta, ja kaksi palvelinpään ajoa
keskeytyi aikaleiman tulkintavirheeseen. Näissä keskeytyneissä ajoissa
jälkikontrollia ei ajettu, mutta omien koepäätteiden ja ETW-istunnon siivous
onnistui. Niitä ei merkitä jälkikäteen läpäisseiksi. Oma virheotos toistettiin
paikallisesti; korjattu tulkinta validoitiin lopuksi uudella oikealla keruulla.

## Automaattinen tapahtumien yhdistäminen

`etw-correlation.mjs` tarkistaa luotetun paikallisen koeajurin tuottaman
aineiston ilman prosessien käynnistämistä, verkkoa tai asetusten muutoksia.
Se ei ole ulkopuolisen aineiston aitoustodistus. Muokattuja paikallisia
raportteja ei voida tällä tavalla todentaa Windowsin allekirjoittamiksi.

Hyväksyntä tehdään vasta kontrollin, AC-tapauksen ja jälkikontrollin jälkeen:

- Kaikissa on sama koebinäärin tiiviste ja neljä erillistä päätepisteporttia.
  Kontrollien echo-vastaukset ja AC:n tyhjät palvelinlaskurit tarkistetaan.
  Jokaisen tapauksen oma elinkaari ja siivous sekä hävikitön ETW-loppukuitti
  vaaditaan. Päätepisteiden muuttuvista laskureista otetaan tapauskohtaiset kopiot.
- Jokaiselle pääprosessin ja jälkeläisen TCP/UDP- ja IPv4/IPv6-yhdistelmälle
  vaaditaan yksi yritys ja vastaava operation-/token-tieto. PID sidotaan
  vaiheen mitattuun tokeniin. Alustus-, bind- tai puuttuva yritys ei riitä.
- Tapahtuman molemmat osoitteet ja portit vastaavat vastaanottavan palvelimen
  ja yrittävän asiakkaan pareja. Otsakeaika osuu yrityksen suljetulle aikavälille
  ilman lisätoleranssia. Jokainen tapahtuma vastaa täsmälleen yhtä yritystä ja
  jokainen kahdeksasta yrityksestä saa vähintään yhden tapahtuman. TCP:n
  uusintapudotukset sallitaan; juuri 12 tapahtumaa ei ole hyväksymisehto.
- Ensimmäinen hyväksytty profiili on tapahtumaversio 2, vastaanottavan
  palvelimen NT-tunniste ja osoiteperheen mukainen ALE receive -kerros.
  Alkuperäinen AppId tarkistetaan, eikä pelkkä johdettu tunniste riitä.
  Suodattimen ID, onnistunut haku, WF-provider, AppIsolation-alikerros,
  BLOCK-toiminto ja täsmällinen loopback-/käyttäjäehtojen rakenne vaaditaan.
  Muu tapahtumaversio, DOS-esitys tai politiikkaprofiili jää selvittämättömäksi.
- Käyttäjäehdon suojauskuvaajan self-relative-rakenne, rajat, SID:t, ACL ja
  tavalliset allow-ACEt tarkistetaan rajatulla dekooderilla. Tuntematon muoto
  hylätään. Käyttöoikeuslaskentaa ei toisteta eikä tietyn ACE:n ratkaisevaa
  vaikutusta väitetä. Allow-ACE tässä ehdossa ei itsessään ole verkkolupa.

Hyväksynnän `scope` on `native-ac-bound-loopback-receive-v2` ja
`fullIsolationVerified` säilyy epätotena. Liveajurin AC-tuloksen
`networkVerified` ja tämän erillisen variaation `passed` voivat muuttua
tosiksi vasta onnistuneen koko ajon korrelaation ja tuloksen tallennuksen
jälkeen. Epäonnistuminen säilyttää verkkotuloksen avoimena. Alkuperäisen
matriisin, LPAC:n, ulkoisen verkon ja koko sovelluksen hyväksyntää ei muuteta.

Aiemman koeaineiston voi tulkita uudelleen projektin Node-runtimella:

```text
node tests/e2e/isolation/replay-etw.mjs <paikallisen-ajon-UUID>
```

Komento lukee vain nimetyt, kooltaan rajatut paikalliset tiedostot ja tulostaa
uuden tulkinnan. Se ei korvaa alkuperäisiä raportteja, käynnistä keruuta eikä
pyydä ylläpito-oikeuksia. Raakatallenteita ja ajotunnisteita ei julkaista.

Automaation paikallinen näyttö:

- 100 testiä läpäisi: aiemmat 32 kuittaustestiä ja 68 uutta korrelaation,
  suojauskuvaajan, lopputilan tallennuksen sekä levyltä tehtävän toiston testiä.
- Kielteiset testit kattavat puuttuvat ja päällekkäiset yritykset,
  epäselvän aika-/socket-osuman, väärän AppId:n tai politiikan, puuttuvan
  jälkikontrollin, hävikin ja siivousvirheet. Myönteisissä tapauksissa ovat
  TCP-uusinnat, aikavälin rajat ja nollallinen payload-aikaleima.
- Aiemman onnistuneen tallenteen toisto yhdisti kaikki 12 tapahtumaa
  kahdeksaan yritykseen automaattisesti. Seitsemän alkuperäisen raportin
  SHA-256-tiivisteet säilyivät samoina ennen toistoa ja sen jälkeen.
- Erotetun koetarkistusfunktion tuloksia verrattiin myös alkuperäisen
  matriisin 11 vanhaan tallenteeseen; tulokset säilyivät samoina.
- Tämä toisto testaa uuden tulkinnan vanhalla raakanäytöllä. Se ei ole uusi
  liveajo eikä alkuperäisen 11 tapauksen matriisin uusinta.
- Uusi liveyritys pysähtyi kerääjän valmiuden aikarajaan. Windows palautti
  korotetun lukijan käynnistykselle peruutuksen; ensimmäinen kontrolli oli
  onnistunut, mutta AC-ajo ja jälkikontrolli jäivät tekemättä. Kerääjän
  tuloshakemistoa ei syntynyt, omat staged-tiedostot poistuivat eikä
  tähän yritykseen kuuluvaa kerääjäprosessia jäänyt. Tätä yritystä ei hyväksytä
  uutena tapahtuma- tai korrelaationäyttönä.
- Seuraava saman variaation liveajo onnistui julkaistulla koodilla ilman
  lähdemuutoksia: kontrolli, AC ja jälkikontrolli hyväksyttiin automaattisesti,
  kokonaisajon `passed=true` ja exit 0. Kontrollit saivat yhteensä 16 echoa;
  AC:n pääprosessin ja jälkeläisen kahdeksaan yritykseen yhdistyi 12
  Windows-pudotusta. AC:n palvelimet eivät hyväksyneet yhteyksiä tai dataa.
  Kerääjä ja vahti päättyivät koodiin 0, oma istunto todettiin poistuneeksi,
  hävikkiä tai callback-virheitä ei ollut, luetut asetukset täsmäsivät ja
  kaikkien kolmen tapauksen oma staged-aineisto poistui. Pysyviä asetuksia
  ei muutettu. `fullIsolationVerified=false` säilyi: tämä hyväksyy vain
  nimetyn loopback-variaation, ei alkuperäistä matriisia tai koko sovellusta.

## Erilliset elinkaarivariaatiot

Normaalin ajon rinnalle on rajattu kolme uutta koetapausta. Jokainen ajetaan
omalla ajotunnisteella ja lyhyellä ETW-istunnolla: tavallinen kontrolli,
yksi AC-tapaus ja tavallinen jälkikontrolli. Keruun aika- ja kokorajat,
kiinteä provider sekä tapahtuma- ja päätepisterajaus säilyvät ennallaan.
Kerääjän skenaario valitsee vain yhden ennalta nimetyn koepolun; se ei
vastaanota vapaata tiedostopolkua eikä käynnistä koepäätettä korotettuna.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\e2e\isolation\run.ps1 -Probe etw -EtwCase error
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\e2e\isolation\run.ps1 -Probe etw -EtwCase launcher-kill -SkipBuild
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\e2e\isolation\run.ps1 -Probe etw -EtwCase owner-kill -SkipBuild
```

`SkipBuild` soveltuu vain jo käännettyyn nykyiseen lähteeseen. Jokainen ajo
pyytää erikseen Windows-vahvistuksen vain tapahtumalukijalle.

| Tapaus | Vaadittava lisänäyttö |
| --- | --- |
| `error` | Koepääte odottaa jälkeläisen mittausten valmistumista ja päättyy tarkoituksella koodiin 17. Hostin exit on 1, Job tyhjä ja natiivi profiilisiivous onnistunut. |
| `launcher-kill` | Ajuri päättää vain oman host-lapsensa molempien koevaiheiden valmistuttua. Kohteen, pääprosessin ja jälkeläisen poistuminen mitataan ennen korjaavaa siivousta. |
| `owner-kill` | Ajuri päättää vain erillisen väliomistajan. Pääajuri, vertailupalvelimet ja keruun valvonta säilyvät; väliomistajan, hostin ja molempien koepäätteiden poistuminen mitataan. |

Tappokohde sidotaan todelliseen spawn-PID:hen ja rooliin. Ajuri varmistaa,
että kohde elää, kirjaa pyynnön ajan ja onnistumisen sekä saman lapsiolion
close-kuitin. Molempien eri koevaiheiden valmius ja kaikki kahdeksan
verkkoyritystä edeltävät tappoa. Poistumishavainnon PID-joukon pitää vastata
kaikkia odotettuja prosesseja; hätäsiivous, puuttuva prosessi tai odottamaton
exit hylkäävät näytön. Profiilin erillinen poistokuitti vaaditaan.

Väliomistajan mukana katkeaa hostin raportointiputki. Prosessien todettu
poistuminen ei yksin todista hostin tietyn EOF-haaran suorittamista.
Verkkonäyttö koskee ennen hallittua virhettä tai tappoa valmistuneita
synteettisiä yrityksiä ja niiden jälkeistä siivousta; se ei kata tappohetken
kilpailutilanteita tai sovelluksen uudelleenkäynnistystä.

Uusien tapausten hyväksyntäraja on
`native-ac-bound-loopback-lifecycle-receive-v2`, ja raportti nimeää
`lifecycleKind`-arvon. `fullIsolationVerified=false` ja
`originalMatrixRun=false` säilyvät. Alkuperäisiä tallenteita ei päivitetä.
LPAC:n käynnistysongelmat, ulkoinen verkko ja täysi sovelluspaketti jäävät
omiksi avoimiksi vaatimuksikseen. Tallennetun ajon lukutoistoon annetaan
sama tapaus toisena argumenttina: `replay-etw.mjs <ajon-UUID> error`.

### Elinkaarivariaatioiden mitattu tulos

Kolme erillistä liveajoa läpäisi: `error`, `launcher-kill` ja `owner-kill`.
Kussakin kontrolli, AC-tapaus ja jälkikontrolli hyväksyttiin; koko kolmikon
exit oli 0. Error-tapauksen odotettu host-exit 1 ja koepäätteen exit 17
eivät ole koko koesarjan epäonnistumisia.

- Jokaisessa ajossa 12 Windows-pudotusta yhdistyi kaikkiin kahdeksaan
  verkkoyritykseen. Kontrollit saivat 16 echo-vastausta ja AC:n vastaanotto-
  ja hyväksyntälaskurit jäivät nollaan. Yhteensä näyttö kattaa 24 yritystä,
  36 pudotusta ja 48 kontrollivastausta.
- Error-tapauksessa jälkeläisen valmiuskuitti edelsi päättymistä. Tarkastuksessa
  löytynyt ajoituskilpailu korjattiin ennen liveä: sidotun virhevariaation
  kuitti kirjoitetaan ennen parentille näkyvää valmiusmerkkiä.
- Käynnistäjän ja väliomistajan tappokohde, elossaolo, onnistunut pyyntö
  ja odotettu close-kuitti täsmäsivät. Molemmat verkkovaiheet valmistuivat
  ennen tappoa. Kolmen tai neljän roolikohtaisen prosessin poistuminen
  varmistettiin ennen korjaavaa siivousta; hätäterminointia ei tarvittu.
- Kaikkien yhdeksän tapauksen oma staged-aineisto poistui. Kaikki kolme
  ETW-istuntoa poistuivat, kerääjät ja vahdit päättyivät koodiin 0, hävikit
  ja callback-virheet olivat nolla ja luetut asetukset säilyivät ennallaan.
- 168 kohdistettua paikallista testiä, 13 natiivia osoitetarkistusta sekä
  muutettujen JavaScript- ja PowerShell-tiedostojen syntaksitarkistukset
  läpäisivät. Natiivikäännös läpäisi `/W4 /WX`. Aiemman normaalin liveajon
  tallennetoisto läpäisi uudella tulkinnalla muuttamatta alkuperäisiä tiedostoja.

Näyttö koskee vain näitä sidottujen loopback-päätepisteiden variaatioita.
Alkuperäistä AC-/LPAC-matriisia ei ajettu uudelleen, eikä vanhoja tuloksia
merkitty jälkikäteen hyväksytyiksi. LPAC:n Winsock-alustus ja jälkeläisen
käynnistyminen tarvitsevat erillisen diagnoosin. Koko sovelluksen, ulkoisen
verkon ja CPU/GPU-paketin näyttö pysyy avoinna; #24 ja parent #10 eivät sulkeudu.

## Lähteet

- [WFP:n sovelluseristyksen alikerros](https://learn.microsoft.com/en-us/windows/win32/fwp/management-filtering-sublayer-identifiers)
- [ALE-vastaanottokerrokset](https://learn.microsoft.com/en-us/windows/win32/fwp/ale-layers)
- [Käyttäjäehdon suojauskuvaajan merkitys](https://learn.microsoft.com/en-us/windows/win32/fwp/permitting-and-blocking-applications-and-users)
- [ACL-rakenne](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-acl)
- [Allow-ACE-rakenne](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-access_allowed_ace)
- [ETW-istunnon käynnistys ja sulkeminen](https://learn.microsoft.com/en-us/windows/win32/etw/configuring-and-starting-an-event-tracing-session)
- [EnableTraceEx2 ja istunnon suodattimet](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-enabletraceex2)
- [Puskurit ja toteutuneet ominaisuudet](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/ns-evntrace-event_trace_properties)
- [ControlTraceW ja lopetus](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-controltracew)

Providerin ja tapahtumaversioiden kuvaus tarkistetaan paikallisen Windowsin
julkaisemasta manifestista. Tämän dokumentin kenttäkuvaus ei oleta jokaisen
Windows-version tuottavan täsmälleen samaa tapahtumaa tai kaikkia estotapauksia.

## Nimetty LPAC + registryRead -normaalikoe

[Käynnistysvertailu](lpac-startup-probe.md#erillinen-registryread-vertailuprofiili)
osoitti erillisen registryRead-LPAC:n toimivan kolmessa startup-operaatiossa.
Tämä seuraava koe mittaa ehdokkaan omat tiedosto- ja loopback-verkkorajat;
AC:n aiempi tulos ei kelpaa sen näytöksi. Nollacapability-LPAC:n vanhoja
kuittauksia tai johtopäätöksiä ei muuteta.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\e2e\isolation\run.ps1 -Probe etw-lpac -EtwCase normal
```

Ensimmäinen sallittu ajurikoe on normaalikolmikko: kontrolli,
`lpac-registry-read-normal` ja jälkikontrolli samoilla päätepisteillä.
Muut candidate-elinkaaret hylätään ajurissa ja korrelaattorissa, kunnes
normaalin näytön perusteella avataan seuraava rajattu vaihe.
`etw-profiles.mjs` omistaa suljetun profiilivalinnan, case-nimen,
kerääjän skenaarion ja tuloksen scopen. Raportti ei valitse omaa profiiliaan.

Natiivin hostin uusi `run-lpac-candidate` sallii vain LPAC:n ja kolme
nimettyä network-elinkaarta; nykyinen startup-verbi säilyy erikseen
neljään diagnoosiin rajattuna. Host varmistaa ennen prosessin jatkamista
saman yhden registryRead-SID:n ja attribuutin kuin startup-vertailussa.
Hostin, primaryn ja descendantin täydet capability-joukot vaaditaan
raportissa; kontrollien joukot ovat tyhjät. Verkkocapabilityjä ei lisätä.
Koe käyttää samoja host- ja probe-binäärejä kaikissa kolmessa tapauksessa.

Kerääjä hyväksyy uuden kiinteän skenaarion vain täsmälliseen
`lpac-registry-read-normal/staged/package/probe.exe`-polkuun. Tapahtumalaji,
AppId-/owner-kuittaus, portti- ja osoiterajaus, aikarajat sekä siivousvahti
säilyvät edellä kuvattuina. Vain kerääjä ja vahti korotetaan; tämä voi
vaatia Windowsin vahvistusikkunan. Koepäätteitä ei koroteta.

Uudessa kolmiossa kaikilta kolmelta tapaukselta vaaditaan tarkka hostin,
primaryn ja descendantin PID-joukko poissa olevaksi ennen korjaavaa
siivousta sekä ajallisesti kelvollinen tarkistuskuitti. Vanhojen AC-normal-
tallenteiden yhteensopivuuspoikkeus ei koske ehdokasta. Hätäsiivous,
puuttuva lapsi tai epäonnistunut profiilin/staged-aineiston poisto hylkää kokeen.

Kahdeksan verkkoyrityksen korrelaatio vaatii samat tarkistetut receiver-v2-,
AppIsolation- ja BLOCK-ehdot kuin AC-kokeessa. Jokaisella yrityksellä pitää
olla vähintään yksi pudotus ja jokaisella kerätyllä pudotuksella täsmälleen
yksi osoite–portti–aika-osuma. Protokolla ja paketti-identiteetti tulevat
koepäätteestä, eivät ETW-tapahtumasta. Uutta tapahtuma- tai suodatinmuotoa
ei hyväksytä automaattisesti. Tulos tallennetaan vain nimetyn ehdokkaan
case-polkuun; onnistunut yhteenveto palautetaan vasta tallennuksen jälkeen.

Tämä normaaliajo ei vielä hyväksy ehdokkaan virhe- tai pakkosulkutilanteita,
ulkoverkkoa, DNS:ää tai koko sovelluksen eristystä. `fullIsolationVerified`
pysyy epätotena, ja alkuperäinen koko matriisi jää edelleen erilliseksi.

### Tallenteen uusintatarkistus ja ensimmäinen yritys

Tallenteen voi tarkistaa uudelleen vain lukevalla `replay-etw.mjs`-ajurilla.
Anna paikallisen ajon UUID, `normal` ja nimenomainen
`lpac-registry-read`-profiili. Oletus säilyy AC:ssa; profiilia ei päätellä
luettavasta tuloksesta. Puuttuva jälkikontrolli tai ehdokkaan oma tulos
hylkää tarkistuksen. Alkuperäisiä tiedostoja ei kirjoiteta uudelleen.

Ensimmäinen liveyritys pysähtyi kerääjän valmiuden aikarajaan.
Kontrolli läpäisi, mutta LPAC-koepäätettä ei käynnistetty eikä
jälkikontrollia tai verkkokorrelaatiota suoritettu. Kerääjän wrapperista
ei saatu täydellistä loppukuittia; tästä ei päätellä käyttäjän
peruuttaneen vahvistusta. ETW-tuloshakemistoa ei syntynyt.
Jälkitarkistus ei löytänyt tähän ajoon kuuluvaa kerääjää, tunnistamatta
jääneitä kerääjäprosesseja tai elossa olevia kontrollin prosesseja.
Molempien valmisteltujen tapausten staged-aineisto poistui.
Pysäytyspyyntö säilyy ajon omassa hakemistossa mahdollista viivästynyttä
käynnistymistä varten. Tämä yritys säilyy epäonnistuneena; se ei anna
LPAC:n verkkorajasta näyttöä. Seuraava koe tarvitsee uuden ajotunnisteen
ja tapahtumalukijan Windows-vahvistuksen valmistumisen aikarajassa.
