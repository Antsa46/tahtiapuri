# Natiivin backendin tuotantoruntime

Tila: issue #10:n toteutussopimus, ei vielä käyttöön valittu tai ajonaikaisesti
hyväksytty backend. Aiempi testiruntime säilyy erillisenä näyttönä.
Electron-main on hyväksytty luotettu omistaja; yksi tavallisen käyttäjän
natiivibroker käynnistää yhden rajatun Noden. Mallin nykyinen käynnistin
ei muutu. Tavalliseen UtilityProcessiin ei tule automaattista varareittiä.

## Omistajuus ja kiinteät juuret

Main valitsee oman datajuurensa alta kiinteän backend-state-hakemiston.
Sen control-alipuu on luotettu: omistusmerkki, yksinoikeudellinen
periytymätön lock ja rajattu palautusjournal. Vain data-alipuu annetaan
backendille, observing sen alla. Electronin koko userData-, MCP- ja
mallihakemistoa ei anneta backendille.

Istunnon väliaikainen juuri johdetaan saman sovellusjuuren alta:
`native-backend/sessions/run-<runNonce>`. Sen package on suljettu,
tarkistettu kopio toimitetusta minimipaketista; scratch on työntekijän
kirjoitettava alue. Journal säilyttää vain tunnetun juuren identiteettiin
sidotut tunnisteet, ei vapaasti seurattavia polkuja. Brokerin komentojoukko
on run/recover, ei yleiskäyttöinen prosessikäynnistin.

Mainin alustava polkutarkistus ei korvaa natiivin avoimiin kahvoihin,
volume/file-identiteettiin ja takaisin luettuihin oikeuksiin sidottua
varmennusta. Reparse, kova tiedostolinkki, väärä omistaja/merkki,
ylimääräinen ohjelmatiedosto ja rajauksen ylittävä kävely hylätään ennen
grantteja. Vain sovelluksen omaa datajuurta käsitellään; mielivaltaisten
käyttäjäkansioiden ACL:iä ei palauteta.

Työntekijä tarkistaa saamansa datajuuren hakemistotyypin, symlink-tilan ja
täsmällisen realpath-vastaavuuden. Esivanhempien validointi ja pinnaus ovat
natiivin omistajan vastuulla; sen kahvat säilyvät normaalin ajon ajan ilman
FILE_SHARE_DELETE-jakotilaa. Työntekijälle riittävät oman datapuun oikeudet.
Kaatumisten ja palautuksen näyttö kuuluu erilliseen hyväksymisporttiin.

Nykyinen observing-aineisto siirretään hallitusti ennen tämän polun valintaa:
validoitu sisältö, revisio ja aktiivinen paikka säilyvät. Lähde säilytetään,
kunnes uusi tallennus on varmennettu. Muutto ei käynnisty koeruntimen avulla
käyttäjän oikealle aineistolle ilman toteutettua ja testattua sovelluspolkua.
Puhdas, käynnistyksestä erillinen
[siirtosuunnittelija](observing-places.md#natiivibackendiin-siirtymisen-esivalmistelu)
on tätä valmisteleva komponentti; se ei toteuta tiedosto-operaatioita.

## Brokerin suhde isäntäprosessiin

Main käynnistää brokerin sekä run- että recover-polulla asetuksella
`detached: true`. ChildProcess pysyy silti seurattuna: `unref()`-kutsua ei
tehdä, kaikki kolme stdio-putkea säilyvät ja portti odottaa todellisen
exit-/close-tapahtuman. Asetus ei siirrä elinkaaren omistajuutta pois Mainilta.

Lukitun Noden Windows-libuv yrittää liittää tavallisen ei-detached-lapsen
omaan KILL_ON_JOB_CLOSE-Jobiinsa. Isännän kuolema voisi silloin päättää
brokerin ennen sen omaa siivousta. Detached ohittaa juuri tämän liitoksen;
se ei pyydä CREATE_BREAKAWAY_FROM_JOB-lippua eikä takaa irtautumista
mahdollisesta muusta ympäröivästä Jobista. Tämä ei ole eristysmekanismi.
Brokerin rajatun työntekijän oma Job, oikeudet ja valvonta säilyvät ennallaan.

Omistajan kadotessa brokerin pitää voida havaita putken sulku tai leasen
vanheneminen, päättää työntekijänsä ja siivota omat resurssinsa ilman
isännän tulosteenlukijaa. Tavallinen sulku ja omistajan menetys varmennetaan
erikseen; lähteestä tunnistettu parent-Job-riski ei yksin todista aiemman
koevirheen syytä tai onnistunutta kaatumissiivousta.

## Windows-polkujen esitykset ja käynnistysrajat

Julkinen polkusopimus, journalista johdetut nimet, pinnien odotetut nimet
ja prosessien argumentit käyttävät normaalia kanonista DOS-polkua.
Natiivin tiedosto-operaation sisäinen apuri lisää vasta leksikaalisen
varmennuksen jälkeen `\\?\`-esityksen. Myös `GetFullPathNameW`-varmennus
tehdään tällä sisäisellä esityksellä, jotta pitkien tiedostopolkujen käsittely
ei riipu Windowsin rekisterin tai manifestin long-path-valinnasta.
Ulkoinen namespace-etuliite, UNC, suhteellinen polku, ADS, tyhjä komponentti,
`.`/`..`-komponentti, loppupiste/-välilyönti ja varatut DOS-laitenimet hylätään.
CON/PRN/AUX/NUL ja COM/LPT 1–9 sekä yläindeksit ¹²³ hylätään myös
kirjainkoosta riippumatta ja tiedostopäätteen edellä. Asemajuuri sallitaan
sisäiselle tiedostoapurille vain esivanhempien pinnausta varten.
Kahvan lopullisen nimen tarkistus vertaa edelleen normaaliin odotettuun
DOS-polkuun lisättyä kiinteää etuliitettä; identiteettiehto ei muutu.

Prosessin käynnistys käyttää normaaleja DOS-polkuja: työhakemiston pituus
on enintään 258 ja suoritettavan tiedoston polun pituus enintään 259 UTF-16-
koodiyksikköä. Main tarkistaa johdetun package-työhakemiston ja node.exe-polun
ennen yksityishakemiston valmistelua tai paketinkopiointia. Natiivi tarkistaa
samat rajat ennen journalin PREPARING-vaihetta ja grantteja. Main tarkistaa
myös toimitetun brokerin todellisen polun ja runtime-työhakemiston ennen
käynnistystä. Paketin muille jälkeläisille ei aseteta 260 merkin kokonaisrajaa:
niiden tiedosto-operaatiot käyttävät sisäistä pitkän polun esitystä.
Recoverin tiedostokäsittely käyttää samaa apuria, mutta uuden lapsiprosessin
käynnistysraja ei estä aiemmin omistetun istunnon siivoamista.

## Ohjelmapaketti ja politiikka

Virallinen lukittu Node, backendin omat JS-tiedostot, backend-transport,
domain/validation, Astronomy Engine, katalogit ja niiden välttämättömät
package.json/export-tiedostot muodostavat suljetun manifestin. Ei koko
node_modules-puuta, SDK:ta, testikoodeja tai synteettisiä boundary-fixturejä.
Sama rakennus tuottaa manifestin ja brokeriin upotetut polku-/koko-/SHA-pinnit.
Muokattava manifesti ei yksin ole luottamusankkuri. Tiedostot tarkistetaan
ja pidetään pinneissä ennen työntekijän resumea.

Descriptorin ja build-manifestin yhteensopivuusmerkintä on
`safetyPolicy: "process-witness-v1"`. Main vaatii sen ennen stagingia ja
run/recover-käynnistystä. Ensimmäisessä hyväksytyssä latauksessa sidotut
descriptor-, build-manifesti- ja broker-hashit säilyvät samoina jokaisessa
uudessa valmistelu- ja käynnistystarkistuksessa. Merkintä kuvaa luotetun
build-ketjun turvasopimuksen versiota.

LPAC + registryRead on nimetyn Node-ehdokkaan politiikka. Capability on
laaja eksplisiittinen poikkeus, ei yksittäisen rekisteriavaimen grantti.
Token, AppContainer-SID, capabilityjoukko, integrity ja Job luetaan takaisin.
LPAC-lippukyselyn null/87/0 ei muutu varmaksi true-arvoksi.

Uusi satunnainen Job on nimetty Global-nimiavaruudessa, private-DACL:n
suojaama ja periytymätön. ERROR_ALREADY_EXISTS hylätään heti. KILL_ON_JOB_CLOSE,
yksi prosessi, yksi suoritin, BelowNormal, prosessin 512 MiB:n
commit-raja ja breakaway-kielto
asetetaan ja tarkistetaan. Node luodaan suspendattuna suoraan tähän Jobiin
PROC_THREAD_ATTRIBUTE_JOB_LIST-attribuutilla. Assign-after-createa ei ole.
Vain kolme nimettyä stdio-kahvaa periytyy. Ympäristö, Node-optiot ja entry
ovat kiinteät. APPDATA, LOCALAPPDATA ja USERPROFILE osoittavat istunnon
omaan scratch-hakemistoon kuten TEMP ja TMP; käyttäjän oikeita
profiilihakemistoja ei peritä. Käynnistys on DETACHED eikä konsoli saa ilmestyä resumeen.

## Toteutuksen ja näytön versiot

T09r:n ensimmäinen toiminnallinen koe ja T09s:n pitkä istunto käyttivät
journal V1:tä. Niissä todennettiin käynnistys, taivas- tai tilakyselyt ja
normaali sulku ilman kielimallia. Näyttö säilyy omana rajattuna
kokonaisuutenaan. Alla oleva journal V2 ja
prosessitodiste ovat T09s:n toteutussopimus; niiden lähde-, katkaisu- ja
palautuskokeet vaaditaan ennen kaatumispalautuksen hyväksymistä.

## Elinkaari ja palautus

`LOCKED → RECOVERING → CLEAN → PREPARING → PREPARED → RUNNING → CLOSING → TERMINATING → RESTORING → PROFILE_DELETED → CLEAN`

Jokaisesta tilasta voi päätyä BLOCKED-tilaan. Se säilyttää aineiston,
estää uudet grantit eikä vaihda ajotapaa. Sovellustyön tulos ja siivouksen
tulos erotetaan: epäonnistunut istunto voi silti päättyä varmennettuun
siivoukseen. Main odottaa myös brokerin todellisen poistumisen ennen
seuraavaa omistusta.

Ennen profiilia, ACL-muutosta tai lasta kirjoitetaan ja flushataan rajattu,
suojattu write-ahead-journal: versio, pakettidigest, käyttäjän identiteetti,
runNonce, koko Job-nimi, aiottu profiili, hyväksytyn datajuuren identiteetti,
DACL-/integrity-peruspolitiikka ja vaihe. Profiilin todettu omistus kirjataan
erikseen ennen grantteja. CLEAN on pysyvä tietue; puuttuvaa journalia ei
nimetä olemassa olevan juuren puhtaudeksi.

Journal V2 on suljettu 18 rivin ASCII/LF-esitys nykyisen 4096 tavun
rajan sisällä. Nykyisten omistus-, juuri-, paketti- ja profiilikenttien
lisäksi se tallentaa prosessitilan NONE/CREATING/RECORDED, PID:n ja koko
GetProcessTimes-luontiajan FILETIME-arvon. PID on DWORD-alueen
kanoninen desimaaliluku; luontiaika säilyy 16 merkin heksajonona.

CREATING kirjoitetaan, flushataan ja luetaan takaisin ennen ainoaa
suspendattua CreateProcessW-yritystä. RECORDED ja palautetusta kahvasta
luettu PID/creationTime vahvistetaan pysyvästi ennen ulkoista PREPAREDia,
STARTia ja ResumeThreadia. Virhe ei palauta tilaa NONEksi eikä salli uutta
luontiyritystä. Myrkytetty journal estää Resumen, palautusmuutokset ja
CLEANin; hallussa oleva varmennettu Job päätetään silti rajatusti.

Normaali sulku lopettaa sisäänoton, käsittelee shutdown-vastauksen ja
sulkee lapsen syötteen järjestyksessä. Tarvittaessa Job päätetään. Sen
nollajäsenyys varmistetaan, data-DACL:t ja integrity palautetaan ja luetaan
takaisin alhaalta ylöspäin, omistettu profiili poistetaan ja väliaikainen
istunto siivotaan. Vasta sitten kirjoitetaan CLEAN ja lähetetään luotettu
loppukuitti. Worker stdout/stderr ei voi todistaa näitä vaiheita.

Recover käyttää samaa lukittua brokeria. Se hankkii yksinomistuksen,
varmentaa journalin ja juuret ja avaa täsmälleen kirjatun Jobin. Olemassa
olevan Jobin omistus, DACL ja rajat tarkistetaan ennen terminatea ja
ActiveProcesses=0-pollausta. Avattu Job-kahva estää last-handle-tapahtuman;
recover ei odota sen yksin tappavan työntekijää.

Job-nimen puuttuminen ei ole päättymistodiste: väliaikaisen olion nimi
voi poistua ennen olion viimeisten kernel-viitteiden vapautumista.
Puuttuvan Jobin haarassa V2:n NONE todistaa luontipolun perusteella, ettei
lasta luotu. CREATING jää epävarmaksi ja estää palautuksen. RECORDED vaatii
kirjatun PID:n sekä creationTimen kanssa täsmäävän prosessikahvan ja
WAIT_OBJECT_0-tuloksen. Query-virhe, identiteettiero ja timeout estävät.
Prosessikysely pyytää vain SYNCHRONIZE- ja QUERY_LIMITED_INFORMATION-oikeudet.

OpenProcessin virhe ei yksin osoita poissaoloa. Sen jälkeen sallitaan yksi
onnistunut TH32CS_SNAPPROCESS-snapshot: täydellinen enumeraatio päättyy
`ERROR_NO_MORE_FILES`-päätökseen, palauttava broker löytyy ja kirjattu PID puuttuu.
Puuttuva oma PID, tyhjä/epätäydellinen tulos tai virhe estää palautuksen.
Muiden prosessien nimiä tai tietoja ei kerätä raporttiin. Todiste käyttää
koko ajan samaa viiden sekunnin budjettia; haarat eivät aloita sitä uudelleen.
Yhden prosessin todiste perustuu lisäksi muuttumattomaan yhden työntekijän,
creation-time Jobin ja breakaway-kiellon kokonaisuuteen.

Vasta päättymistodiste sallii oikeuksien palautuksen, profiilin ja istunnon
poiston sekä CLEANin. Vanha journal-versio estetään myös CLEANina; migraatio
ja pakettidigestin vaihdon yhteensopivuus ovat erillinen avoin portti.
Uudelleen validoidut datajälkeläiset eivät saa johtaa juuren ulkopuolelle.
Turvatonta puuta ei seurata tai poisteta korjauksena.

Profiilin luomisen ja sen pysyvän onnistumismerkinnän välinen kaatuminen
voi jättää omistuksen epäselväksi. Ensimmäinen toteutus estää tämän
ambivalentin tilan automaattisen käytön; se ei poista todistamatonta
profiilia. Dokumentoitu idempotentti DeleteAppContainerProfile sopii vain
varmasti omistetun profiilin uudelleenyritykseen.

Tavoite on prosessikaatumisesta palautuminen. Puuttuva/korruptoitunut/torn
journal estää käytön; sähkökatkokestävää tallennuksen atomisuutta ei vielä
luvata. Epävarman siivouksen jälkeen main vaatii recoverin ennen uudelleenkäyttöä,
vaikka edellinen broker olisi poistunut tai journal todellisuudessa jo CLEAN.

## Pitkäikäinen TBIP/2

Tuotannolla on oma versioitu 56 tavun otsake: magic TBIP@0, versio u16=2@4,
kind u16@6, sequence u64LE@8, payloadBytes u32@16, reserved u32=0@20,
32 tavun nonce@24. Järjestysnumero on bigint/uint64 alkaen yhdestä eikä
saa kiertyä. Testin TBIP/1 ja sen 48 tavun otsake eivät muutu.

KINDit säilyvät: START=1, APP=2, CLOSE_CHILD_INPUT=3, KILL=4,
HEARTBEAT=5, PREPARED=129, STARTED=130, CHILD_CHUNK=131, RESULT=132, STDERR=133.
HEARTBEAT on tyhjä omistajakehys vain STARTEDin jälkeen; START pysyy
kertaluonteisena aloitusrajana. Worker saa erikseen nykyisen runtime.pingin.
Omistajan ja lapsen noncealueet ovat erilliset. APP syötteenä enintään
64 KiB, lapsen tulosteena 16 MiB. Rajatut pending-tavut ja viestit sisältävät
aktiivisen kirjoituksen. Eliniän 20 sekuntia, 256 viestiä, 64 MiB ja 2048
lohkoa sekä kasvavat raakakehyslistat poistuvat tuotannosta.

Työntekijän virhediagnostiikka rajataan yhteen alle 256 tavun stderr-riviin:
kiinteä virheluokka, syscall ja ohjelman määräämä tarkistusvaihe. Viestiä,
polkua tai pinoa ei välitetä. Kirjoituksen kuittaus tai enintään 200 ms:n
ajastin päättää prosessin kerran. Diagnostiikka ei muuta eristyksen oikeuksia
eikä korvaa brokerin loppukuittia.

Alustavat integroitavassa kokoonpanossa todennettavat oletukset:

| Vaihe | Raja |
| --- | --- |
| Valmistelu | 30 s |
| START → ensimmäinen kokonainen APP-kehys (broker) | 10 s |
| STARTED → validoitu ready (Main) | 10 s |
| Osittaisen kehyksen tavuedistymisen puute | 2 s |
| Yhden kehyksen kokonaisikä | 15 s |
| Owner lease | heartbeat 2 s, vanheneminen 10 s |
| Hallittu shutdown | 2 s |
| Pakotettu Jobin tyhjennys | 5 s |
| ACL-/profiili-/istuntosiivous | 15 s |
| Loppukuitin drain | 2 s |

Broker tarkistaa ensimmäisen APP-kehyksen valmistumisen; JSON-viestin
`ready`-merkityksen ja istunnon tarkistaa Mainin sovitin. Mainin koko
käynnistysbudjetti on enintään 40 s, joka sisältää valmistelun ja ready-vaiheen.

Ajat ovat monotonisia. Osittaisuuden aikaraja alkaa vasta ensimmäisestä
tavusta; tyhjä odottava kanava ei ole virhe. Kokonaisikä estää hitaan
tavutiputtelun. Synchronous ReadFile/WriteFile -kutsuista riippumaton
valvonta pakottaa vaiheiden rajat. KILL ja omistajan EOF eivät odota täyttä
worker-jonoa. Siivous ei saa riippua ownerin stdoutin lukemisesta.

## Hyväksymisportti

Ennen oletuspolun vaihtoa testataan sama Electronin minimipaketti:
vanhat kokonaiskiintiöt ylittävä ja tyhjänä odottava backend, observingin
säilyminen/migraatio, omistajan ja brokerin kaatuminen sekä recover,
rajattu shutdown ja yksi oikeaan CPU-malliin sidottu käyttötapaus.
Juuri tämän Node-/paketti-/politiikkakokoonpanon verkkokielto tarvitaan.
MCP, FMI, CUDA ja koko paketin alkuperäiset ehdot säilyvät avoimina,
kunnes vastaava näyttö saadaan. Unit- tai probe-tulos ei vaihda oletuspolkua.

Yhden istunnon aiemmat tavu- ja CHILD_CHUNK-kokonaisrajat on ylitetty
[rajatussa normaalikokeessa](../experiments/native-backend-runtime.md#t09un-yhden-istunnon-tavu--ja-lohkorajat).
Tämä osanäyttö ei hyväksy yllä olevaa koko sovelluspaketin porttia.

## Ensisijaiset toteutuslähteet

- [Jobin elinkaari ja KILL_ON_JOB_CLOSE](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Kernel-olion nimi, kahvalaskuri ja viitelaskuri](https://learn.microsoft.com/en-us/windows-hardware/drivers/kernel/life-cycle-of-an-object)
- [Prosessin asynkroninen päättäminen ja odotus](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess)
- [Koko prosessilistan snapshot](https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/nf-tlhelp32-createtoolhelp32snapshot)
- [Creation-time Job-lista](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- [Global- ja istuntonimiavaruudet](https://learn.microsoft.com/en-us/windows/win32/termserv/kernel-object-namespaces)
- [Profiilin luonti](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile)
- [Profiilin poisto ja uudelleenyritys](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-deleteappcontainerprofile)
- [Windowsin polkujen enimmäispituus ja extended-esitys](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation)
- [Työhakemiston pituusraja](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setcurrentdirectory)

- [Lukitun Noden libuv: parent-Jobin luonti](https://github.com/nodejs/node/blob/v24.22.2/deps/uv/src/win/process.c#L69-L121)
- [Libuv: detached-liput ja ehdollinen Job-liitos](https://github.com/nodejs/node/blob/v24.22.2/deps/uv/src/win/process.c#L1052-L1102)
- [Noden detached-asetus ja prosessin viitteet](https://github.com/nodejs/node/blob/v24.22.2/doc/api/child_process.md#optionsdetached)
