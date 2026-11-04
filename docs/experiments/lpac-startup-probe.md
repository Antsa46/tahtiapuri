# LPAC:n käynnistyksen erotettu diagnoosi

T09a / #24:n alkuperäisessä kokeessa LPAC:n Winsock-alustus palautti 10107
ja sen jälkeen lapsen CreateProcessW palautti 5. Tämä koe erottaa operaatiot
ja vertaa viestikahvojen perintää. Se ei korjaa virhettä oikeuksia lisäämällä.
[Alkuperäinen koe ja tulokset](windows-isolation-probe.md) säilyvät ennallaan.

## Rajaus ja ajotapa

Erillinen `native/startup-probe.cpp` käyttää samaa natiivia hostia, omaa
satunnaisnimistä profiilia, Jobia, nollacapabilityjä ja synteettistä
koepakettia. Koebinääri kopioidaan staged-paketin `probe.exe`:ksi;
alkuperäistä koepäätettä tai sovelluksen ajotapaa ei vaihdeta.

Jokaisessa kolmesta tilasta ajetaan tavallinen kontrolli, AC, LPAC ja
jälkikontrolli. Kaikki käyttävät samaa diagnoosibinääriä. Alkuperäinen
profiili-, ACL-, sentinel- ja Job-käytäntö säilyy. Kuitti erottaa hostin,
pääprosessin ja mahdollisen jälkeläisen sekä varmistaa niiden poistumisen
ennen korjaavaa siivousta. Hätäsiivous ei kelpaa elinkaarinäytöksi.

| Tila | Tehtävä |
| --- | --- |
| `startup-child` | Yksi lapsenluonti ennen yhtään koepäätteen WSAStartup-kutsua. Alkuperäisen kaltainen kolmen stdio-kahvan HANDLE_LIST ja perintä. Lapsi ei luo lisää lapsia tai kutsu Winsockia. |
| `startup-no-inherit` | Sama minimaalinen lapsi ilman kahvaperintää ja stdio-asetuksia. Lapsi kirjoittaa oman scratch-alueen määrämuotoisen kuitin; ajuri lukee sen lapsen päätyttyä. |
| `startup-winsock` | Vain WSAStartup(2.2) ja onnistumisen jälkeen WSACleanup. Ei lapsenluontia tai socket-operaatioita. |

Kokeessa ei ole echo-palvelimia, ETW-keruuta tai korotettuja prosesseja.
Se ei muuta palomuuria, rekisteriä, yleisiä käyttöoikeuksia tai capabilityjä.
Uusia työkaluja ei asenneta. Koetulokset ja tunnisteet pysyvät Gitistä
rajatussa `.artifacts/tests/isolation/startup-runs/`-puussa.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\e2e\isolation\run.ps1 -Probe startup
```

`-SkipBuild` sopii vain, jos nykyiset lähteet on jo käännetty. Paikallisen
Node-runtimen ja olemassa olevan C++-työkaluketjun käytäntö säilyy
[alkuperäisen kokeen](windows-isolation-probe.md#koetoteutus-ja-toistaminen) mukaisena.

## Näytön tulkinta

- API-paluu ja sen välitön virhekoodi kirjataan erikseen. CreateProcessin
  onnistuminen vaatii lisäksi lapsen mitatun tokenin, Job-jäsenyyden,
  oikean PID:n, täydet kuitit ja onnistuneen päättymisen.
- Molemmat prosessit kokeilevat vain synteettisen sallitun tiedoston,
  AAP-only-tiedoston ja ulkopuolisen koetiedoston lukua. LPAC:n suoran
  tokenkyselyn 87 jää null-tulokseksi; AAP-käyttäytymistä ei muuteta lipuksi.
  API, tietoluokan numero, puskurikoko, palautuspituus ja kyselyn
  suorittaminen kirjataan erikseen.
- Stdio-kahvojen kelpoisuus, tyyppi ja perintäliput mitataan niitä muuttamatta.
  No-inherit-kuitissa sallitaan joko puuttuvat stdio-kahvat tai kolme
  kelvollista merkkilaitekahvaa. Sekamuoto ja vanhempaa vastaavat stdout-/stderr-
  putkikahvat hylätään; pelkkä tyyppi ei yksilöi kahvan objektia. Sen CREATE_NEW-tiedoston
  koko on enintään 16 KiB, rivit on rajattu ja viimeinen rivi on loppukuitti.
  Tiedostokanava ei saa tuottaa hostin tapahtumia.
- No-inherit muuttaa HANDLE_LISTin, perintälipun, STARTF_USESTDHANDLESin ja
  lapsen raportointikanavan. Pelkkä ero näiden variaatioiden välillä ei
  yksilöi viallista kahvaa tai objektin ACL:ää. Ennen WSAStartup-kutsua
  tehty lapsikoe ei myöskään tarkoita, ettei Winsock-DLL olisi ladattu.
- `diagnosticComplete` tarkoittaa ehjää mittausta, `operationSucceeded`
  API-operaation onnistumista ja `compatible` tämän rajatun käynnistyksen
  toimivuutta. API-virhe säilyy epäonnistuneena yhteensopivuutena. Koko
  ajon `passed` ja exit 0 vaativat kaikkien tapausten yhteensopivuuden;
  kokonaan mitattukin LPAC-epäonnistuminen tuottaa exit 1.
- `isolationVerified=false`, `networkAttempted=false` ja
  `originalMatrixRun=false` säilyvät. Koepäätteen lähde ei kutsu socket-,
  connect- tai DNS-rajapintoja; tämä ei ole ulkoisen verkon estokoe.

## Mitattu tulos

Ensimmäinen ajo valmistui neljän lapsikokeen osalta ja pysähtyi viidennen
no-inherit-kontrollin liian tiukkaan mittausoletukseen. Lapsenluonti ja
lapsen päättyminen onnistuivat, mutta lapsen raportissa oli kolme kelvollista
CHAR-kahvaa odotettujen puuttuvien kahvojen sijaan. Kaikki viisi siivousta
onnistuivat. Alkuperäinen keskeytynyt raportti säilyy muuttumattomana.

Validaattoria täsmennettiin hyväksymään vain edellä kuvatut kaksi tarkkaa
no-inherit-kahvamuotoa. Kahvan `flags=1` kertoo edelleenperiytyvyydestä,
ei siitä, että se olisi peritty vanhemmalta. Natiivibinääri, käynnistysliput
ja oikeuspolitiikka säilyivät. Uusinta teki kaikki 12 tapausta loppuun:

| Operaatio | Kontrolli | AC | LPAC | Jälkikontrolli |
| --- | --- | --- | --- | --- |
| Lapsenluonti kahvaperinnällä ennen WSAStartupia | Onnistui | Onnistui | Virhe 5 | Onnistui |
| Lapsenluonti ilman kahvaperintää | Onnistui | Onnistui | Virhe 5 | Onnistui |
| Pelkkä WSAStartup(2.2) | Onnistui | Onnistui | Virhe 10107 | Onnistui |

- Kaikki 12 mittausta olivat täydet. Yhdeksän operaatiota onnistui;
  kolme LPAC-operaatiota epäonnistui. Kokonaistulos säilyi `passed=false`,
  `compatible=false` ja exit 1.
- Kuuden onnistuneen lapsen oma identiteetti, Job-jäsenyys, lukurajat,
  loppukuitit ja exit 0 varmistuivat. LPAC-lapsia ei syntynyt.
- Kaikki omat prosessijoukot poistuivat ennen korjaavaa siivousta.
  Kaikkien 12 tapauksen profiili- ja staged-siivous onnistui ilman hätätoimia.
- LPAC:n suora tokenkysely jäi edelleen tulokseen null / virhe 87.
  Kysely tehtiin neljän tavun puskurilla; epäonnistumista ei muutettu lipuksi.
  AAP-only-lukukoe erotti AC:n ja LPAC:n käyttäytymisen erikseen.
- 79 kohdistettua paikallista testiä läpäisi: 58 käynnistysdiagnoosin ja
  21 yhteisen raportti-/prosessiapurin testiä. JavaScript- ja PowerShell-
  syntaksitarkistukset sekä natiivikäännös `/W4 /WX /MT` läpäisivät.

Tuloksesta voidaan päätellä, ettei LPAC:n lapsenluonnin virhe tarvitse
edeltävää koepäätteen WSAStartup-kutsua. Myöskään kahvaperinnän ja
stdio-asetusten poistaminen ei riittänyt poistamaan virhettä. Winsockin
virhe toistui erillisessä prosessissa ilman lapsenluontia. Nämä havainnot
eivät yksilöi kummankaan virheen estävää resurssia tai tarkkaa syytä.

## Oman ohjelmatiedoston ja prosessin resurssidiagnoosi

Seuraava erillinen, vain pääprosessissa ajettava `resource-once`-tila
vertaa kontrollia, AC:ia, LPAC:ia ja jälkikontrollia muuttamatta
nollacapability-profiilia tai omien tiedostojen oikeuksia. Se käyttää
samaa hostia ja siivousta, mutta omaa `resource-probe.exe`-koebinääriä.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\e2e\isolation\run.ps1 -Probe resources
```

Jokainen koepääte avaa vain oman staged-`probe.exe`:n erikseen
`FILE_READ_DATA`- ja `FILE_EXECUTE`-pyynnöillä, `OPEN_EXISTING`-tilassa.
Tarkka maski ja välitön virhe tallennetaan; tiedostoa ei suoriteta tämän
avauksen perusteella. Sallitun, AAP-only- ja ulkopuolisen synteettisen
fixturen avaukset varmentavat vertailun nykyisillä oikeuksilla.

Omalta tokenilta luetaan `TokenDefaultDacl` vain `TOKEN_QUERY`-oikeudella.
Kaksi kyselyvaihetta, 64 KiB puskuriraja, ACL:n rajat ja validius tarkistetaan.
Null-DACL, tyhjä ACL, muu onnistunut sisältö ja kyselyvirhe säilyvät eri tuloksina.
Paikallinen SDDL-kuitti on enintään 16 KiB; oikeita käyttäjätunnisteita ei
julkaista tai kopioida fixtureihin. Serialisointia varten rakennettua
muistissa olevaa suojauskuvaajaa ei aseteta mihinkään käyttöjärjestelmäobjektiin.

Oman prosessin lapsenluontikäytäntö luetaan
`GetProcessMitigationPolicy(ProcessChildProcessPolicy)`-kutsulla.
Puskurikoko, raakaflagit, `NoChildProcessCreation` ja välitön virhe kirjataan.
Epäonnistunut kysely jää tuntemattomaksi, ei nollalipuksi.

Täydellinen diagnoosi edellyttää kaikkia seitsemää havaintoa, oikeaa
identiteettiä, Jobia, prosessien poistumista ennen siivousta ja omien
profiilien/tiedostojen onnistunutta siivousta. Se ei vaadi LPAC:n kaikkien
resurssipyyntöjen onnistumista. Kontrollin oman tiedoston avaukset ja
metatietokyselyt vaaditaan toimiviksi. Tässä kokeessa ei luoda lasta,
kutsuta Winsockia tai avata verkkoa. `startupAttempted`, `startupVerified`
ja `isolationVerified` pysyvät epätosina, vaikka diagnoosi valmistuu.

Resurssien avaus ei todista koko CreateProcess-polun toimivuutta.
Tokenin oletus-DACL koskee uusien objektien oletussuojausta; se ei ole
suoritettavan tiedoston DACL. Nollassa oleva lapsenluontimitigaatio ei
sulje pois muita käynnistystä estäviä ehtoja.

### Resurssikokeen mitattu tulos

Kaikki neljä tapausta valmistuivat ja päättyivät koodiin 0. Tämä on
resurssidiagnoosin valmistuminen, ei käynnistysyhteensopivuuden hyväksyntä.

- Oman koebinäärin erilliset read(1)- ja execute(32)-avaukset onnistuivat
  myös LPAC:ssa. Sallitun, AAP-only- ja ulkopuolisen fixturen avaukset
  vastasivat odotettuja AC-/LPAC-rajoja.
- Tokenin oletus-DACL:n kysely onnistui kaikilla; ACL ei ollut null tai tyhjä.
  Kontrollissa oli kolme ACE:tä, AC:ssa ja LPAC:ssa neljä. Normalisoitu
  rakenne oli sama: käyttäjä ja SYSTEM täydellä pääsyllä, kirjautumisistunto
  luku-/suoritusoikeudella sekä AC/LPAC:ssa lisäksi oma paketti täydellä
  pääsyllä. Oikeat tunnisteet säilyvät vain paikallisissa kuiteissa.
- Lapsenluontikäytännön kysely onnistui kaikilla; raakaflagit olivat 0 ja
  `NoChildProcessCreation=false`.
- Kaikki neljä prosessijoukkoa poistuivat ennen korjaavaa siivousta.
  Profiilit ja staged-aineistot siivoutuivat ilman hätätoimia.
- 120 kohdistettua testiä läpäisi: 41 resurssidiagnoosin, 58 aiemman
  käynnistysdiagnoosin ja 21 yhteisen prosessiapurin testiä. Natiivikäännös
  `/W4 /WX /MT` sekä JavaScript- ja PowerShell-syntaksitarkistukset läpäisivät.
  Erillinen tarkastaja varmisti lähteen, binäärit ja raakakuitit.

Tulos ei tue näiden oman tiedoston avausoikeuksien puutetta tai
NoChildProcessCreation-lippua aiemman virheen selityksenä. Samankaltainen
oletus-DACL ei todista käynnistyksessä tarvittavien muiden objektien pääsyä.
Alkuperäiset CreateProcess- ja Winsock-virheet säilyvät avoimina.
Seuraava selvitys kohdistuu käynnistyksen muuhun resurssipääsyyn. Tarkka
jäljitysmenetelmä ja sen tarjoama status-/nimikenttä varmistetaan ennen
uutta keruuta; resurssikokeen valmistuminen ei itsessään käynnistä keruuta.

## Jatko ja hyväksymisraja

Seuraava rajattu selvityskohde on käynnistyksen tarvitsemien resurssien
pääsy: esimerkiksi oman ohjelmatiedoston ja kiinteiden järjestelmäresurssien
vain luku -diagnoosi nykyisen tokenin alla. Tarkka resurssilista ja sen
näyttöraja on määritettävä ennen toteutusta. Lisäcapabilityn antaminen
(esimerkiksi `registryRead`) olisi eri oikeusprofiilin koe, ei tämän
nollacapability-kokeen korjaus tai hiljainen hyväksyntä.

Alkuperäinen AC-/LPAC-matriisi ja sen avoimet elinkaarikokeet, LPAC:n
käynnistysyhteensopivuus, ulkoinen verkko sekä koko sovelluksen CPU/GPU-
minipaketti jäävät avoimiksi. #24 ja #10 pysyvät avoinna. Tämä diagnoosi
ei muuta aiempia verkkotuloksia tai niiden hyväksymisehtoja.

## Lähteet

- [Microsoft: tiedostojen tarkat pääsyoikeudet](https://learn.microsoft.com/en-us/windows/win32/fileio/file-access-rights-constants)
- [Microsoft: TokenDefaultDacl](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_default_dacl)
- [Microsoft: prosessin suojauskäytäntöjen lukeminen](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocessmitigationpolicy)
- [Microsoft: standardikahvojen käsittely](https://learn.microsoft.com/en-us/windows/console/getstdhandle)
- [Microsoft: CreateProcessW ja kahvaperintä](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)
- [Microsoft: WSAStartupin suora paluukoodi ja alustuksen elinkaari](https://learn.microsoft.com/en-us/windows/win32/api/winsock/nf-winsock-wsastartup)
- [Microsoft: Winsock-virhekoodit](https://learn.microsoft.com/en-us/windows/win32/winsock/windows-sockets-error-codes-2)
- [Microsoft: AppContainerin ja LPAC:n käynnistys](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)

10107 on yleinen järjestelmäkutsun epäonnistuminen. Dokumentaatio nimeää
useita mahdollisia syitä, myös katalogiin liittyvät rekisteritoiminnot;
virhekoodi ei yksin yksilöi tässä ajossa puuttuvaa oikeutta.
