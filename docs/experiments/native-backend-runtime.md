# Natiivibackendin ensimmäinen toiminnallinen koe

T09r–T09w, issue #10:n rajattuja osatuloksia. Natiivin backendin pohja toimii
rajatuissa Windows-kokeissa. Sovelluksen oletusbackend ei vielä vaihdu
eikä issue valmistu tämän näytön perusteella.

Omistajuuden, oikeuksien, TBIP/2:n ja palautuksen sopimus on
[natiivin backendin arkkitehtuurissa](../architecture/native-backend-runtime.md).
Tässä kuvataan tehty koe ja sen rajat.

## Kokoonpano

Koe käyttää tuotantokandidaatin suljettua ohjelmapakettia: virallinen
lukittu Node, varsinainen backend, domain/validation, backend-transport,
Astronomy Engine ja paikalliset katalogit. Paketin 40 tiedostoa ja manifesti
sidotaan brokeriin upotettuihin koko-/SHA-pinneihin. Testikoodeja tai
koko node_modules-puuta ei toimiteta työntekijälle.

Electronin backend-ohjain ja uusi NativeBackendPort käyttävät natiivibrokeria.
Graafista Electron-sovellusta, kielimallia, GPU:ta tai sää-APIa ei
käynnistetä. Aineisto on synteettistä ja erillään sovelluksen käyttäjätiedoista.
Pyydetty politiikka on LPAC + registryRead; LPAC-lippukyselyn null/87/0
säilyy epävarmana havaintona. Natiivin takaisin luetut Job-rajat ovat yksi
prosessi, yksi suoritin, BelowNormal ja prosessin 512 MiB:n commit-raja.
Verkkokieltoa ei tämän kokeen yhteydessä yritetty todistaa.

## Todennettu toiminta

Tuoreen datajuuren palautusalustus sekä kaksi peräkkäistä backend-istuntoa
läpäisivät. Ensimmäinen istunto palautti ready-viestin ja runtime-tilan,
luki tyhjän havaintopaikkatilan, tallensi ja aktivoi testipaikan revisioon 2
sekä palautti täydellisen 5 079 kohteen taivaan: 5 070 tähteä ja yhdeksän
aurinkokunnan kohdetta. Toinen istunto palautti saman revision, paikan ja
aktiivivalinnan levyltä.

Molemmat istunnot vastasivat hallittuun shutdowniin, ja workerin sekä
brokerin poistumiskoodi oli 0. Luotettu loppukuitti oli normal/clean:
Job tyhjä, dataoikeudet palautettu, profiili ja istuntokansio poistettu,
journal CLEAN. stderrComplete ja molemmat konsolittomuushavainnot olivat
true, eikä stderr-tulostetta tullut. Tunnettujen prosessitunnisteiden
poissaolo tarkistettiin lisäksi erikseen.

Riippumaton tarkastaja purki säilytetyt ulommat ja sisemmät TBIP/2-kehykset,
vertasi vastaukset raporttiin sekä tarkisti levyn observing-tarkistussumman,
CLEAN-journalin, tyhjän sessions-hakemiston ja rakennuksen lähde-/pakettipinnit.
Lähtevä pyyntövirta ei kuulu raakatallenteeseen: täsmällisen pyyntö–vastausparin
varmistaa myös katselmoitu ohjain ja portti. ACL-palautuksen ja profiilin
poiston näyttö on brokerin kuitti ja lähdepolku, ei erillinen Windows-auditointi.

## T09r:n kohdistetut tarkistukset ja korjaukset

- Kuljetus, stdio-backend ja ParentModelEngine: 49 testiä.
- NativeBackendPort, ohjain ja malliperuutuksen integraatio: 55 testiä.
- Desktopin runtime-resurssit: 14 testiä.
- Suljetun paketin kerääjä: 11 testiä.
- Erillinen natiivipolun koe: kuusi tapausta, mukana yli 260 merkin
  tiedostopolku sekä hardlink- ja hakemistojunction-hylkäykset.
- Backendin ja desktopin kohdistetut TypeScript-rakennukset sekä
  lopullisen natiivibrokerin käännös onnistuivat.

Luvut kuvaavat eri kohdistettuja ajoja; niitä ei esitetä yhtenä koko
sovelluksen testiajona. Aiemmat epäonnistuneet tulokset säilyvät paikallisessa
näytössä. Kokeet paljastivat pitkien Win32-polkujen käsittelyn puutteen,
puuttuvat scratch-profiilimuuttujat sekä työntekijän tarpeettoman yksityisten
esivanhempien metatietokyselyn. Korjaukset katselmoitiin ja kokeet uusittiin
uusilla rakennuksilla ja testijuurilla. Käyttöoikeuksia ei laajennettu
esivanhempiin.

## T09s:n pitkä istunto ja journal V2

Yksi V1-istunto läpäisi 25 sekunnin jakson ilman käyttäjätoimintoja sekä
321 erikseen paritettua tilakyselyä. Jakson aikana kulkivat normaalit
runtime.pingit ja kontrolliheartbeatin viestit; kyse ei ollut tyhjästä
johtoyhteydestä. Molemmat tavusuunnat ja kirjoitusten callbackit tallennettiin
rajatusti. Ensimmäisen yrityksen tallenninjono täyttyi; testin tuottaja
muutettiin odottamaan tallennusta muuttamatta tuotannon tai tallentimen rajoja.
Uusinnan raakatallenteet ja normaali sulku tarkastettiin riippumattomasti.

Palautuksen jatkotarkastelu erotti Job-nimen puuttumisen prosessin
päättymistodisteesta. Toteutus siirtyi journal V2:een ja vaatii puuttuvan
Jobin RECORDED-haarassa erillisen prosessitodisteen. Vanhan runtime-kuvauksen
hyväksyminen estetään ennen stagingia ja käynnistystä. Tarkat ehdot omistaa
[palautussopimus](../architecture/native-backend-runtime.md#elinkaari-ja-palautus).

V2:n deterministinen natiivitesti läpäisi 120 vaiheen, prosessitilan ja
profiilitilan yhdistelmää sekä todistus-, aikaraja-, commit- ja myrkytystapaukset.
Desktopin resurssitarkistusten 31 testiä, kohdistettu TypeScript-rakennus ja
koko natiivibrokerin käännös läpäisivät. Riippumaton tarkastaja varmisti
lähteet, käännösketjun ja testien todelliset poistumiskoodit.

Uudella V2-paketilla toistettiin tuore alustus, tallennus ja aktivointi,
5 079 kohteen taivas sekä tarkka säilyminen toisessa istunnossa. Molemmat
työntekijät ja kaikki kolme brokeria poistuivat koodilla 0. Kolme vasta
brokerin todellisen sulkeutumisen jälkeen luettua journal-kopiota olivat
kelvollisia ja samoja CLEAN/NONE-tietueita; istuntokansiot olivat tyhjät.
Raakatallenteet, levyn tila ja ohjelmapaketin pinnit tarkastettiin erikseen.
Tässä normaalikokeessa lähteviä tavuja ei tallennettu. Natiivitesti ja normaali
uudelleenkäynnistys eivät vielä todenna oikeaa kaatumispalautusta tai sen
handle-/snapshot-haaraa.

## T09s:n ensimmäinen varhainen katkaisusarja

Erillinen natiivi koeharness katkaistiin kahdessa kohdassa: suspendatun
työntekijän luomisen jälkeen CREATING-tilassa sekä identiteetin pysyvän
RECORDED-kirjauksen jälkeen. Työntekijää ei jatkettu. Koeajuri päätti oman
harnessinsa tunnetusta prosessikahvasta ja odotti työntekijän päättymistä.
Harnessin token-/Job-/konsolitarkistukset tehtiin ennen RECORDED-kirjausta;
varsinaisessa brokerissa ne tehdään kirjauksen jälkeen.

CREATING-tapauksessa puuttuva Job johti estettyyn palautukseen: ei journalin
kirjoitusta, oikeuksien palautusta tai profiilin/istunnon poistoa. Säilytetyt
journalit ja tiedosto-/oikeusinventaariot olivat samoja. RECORDED-tapauksessa
oikea OpenProcess-kahva, koko luontiajan täsmääminen ja WAIT_OBJECT_0
edelsivät siivousta. Profiilin rekisteritilaa ei inventoitu erikseen.

Kolmannen tapauksen oli tarkoitus todentaa snapshot-haara omien työntekijä-
kahvojen sulkemisen jälkeen. OpenProcess onnistui silti, ja palautus käytti
sallittua kahva-/odotustodistetta sekä päätyi CLEAN-tilaan. Snapshotia ei
kutsuttu. Koeajuri hylkäsi tämän, pysäytti sarjan ja säilytti aineiston.
Koko sarjan poistumiskoodi oli 1; aiempien tapausten raportit jäävät oman
sopimuksensa mukaan alustaviksi. Riippumaton tarkastus vahvisti yllä kuvatut
raakahavainnot, mutta koko sarjaa tai snapshot-näyttöä ei hyväksytty.

Yksi erillinen viivästetyn uudelleenkäynnistyksen diagnoosi odotti omien
kahvojen sulkemisen jälkeen kiinteät viisi sekuntia. Dirty-journalin tavut
säilyivät samoina odotuksen yli. Palautus käytti edelleen täsmäävän
prosessikahvan odotustodistetta ja valmistui, joten myös tämä diagnoosi
hylättiin snapshot-kriteerillä. Viivettä ei viritetty uusilla yrityksillä.

Myöhempi, samaan tallennettuun prosessi-identiteettiin sidottu lukukoe
käytti muuttamatonta tuotannon prosessitodistefunktiota kerran. OpenProcess
epäonnistui luonnollisesti, ja oikea Windows-snapshot lueteltiin loppuun:
lukija itse löytyi ja kirjattu PID puuttui. Todiste valmistui saman viiden
sekunnin budjetin sisällä. Tallennetut journalit ja nykyinen CLEAN-tila
säilyivät samoina; palautusta tai resurssien siivousta ei kutsuttu.
Riippumaton tarkastaja vahvisti raakatallenteen, todelliset sulkukoodit ja
muuttumattomat lähtötiedot. Tämä todentaa tuotannon todistusfunktion
snapshot-haaran, mutta ei muuta aiempia hylättyjä kokeita hyväksytyiksi eikä
ole koko kaatumispalautuksen näyttöä.

Lukukokeen ensimmäinen käynnistys ei tuottanut natiivihavaintoja.
Lähdekatselmus osoitti ristiriidan ohjelman putkivaatimuksen ja PowerShellin
tiedostoonohjauksen välillä; epäonnistuneen ajon kahvatyyppiä ei tallennettu.
Erillinen Node-välitin korjasi käynnistystavan muuttamatta natiiviohjelmaa,
sen turvarajoja tai todistusfunktiota. Myös tämä ensimmäinen tulos säilytettiin.

Varhaiset katkaisuhavainnot ovat erillisestä harnessista. Varsinaisen
brokerin alla kuvattu koe on oma rajattu näyttönsä.

## T09s:n varsinainen brokerin katkaisu ja palautus

Tuoreen juuren alustus ja oikea backend-istunto valmistuivat ennen katkaisua.
Ohjain sai typed ready- ja status-vastaukset, tallensi ja aktivoi synteettisen
havaintopaikan revisioon 2 sekä luki täsmälleen saman tilan takaisin.
Odottavia pyyntöjä ei ollut, kun testi katkaisi oman brokerinsa prosessin.
Brokerin todellinen poistuminen ja putkien loppuminen havaittiin.
Luotettua RESULTia ei tullut, ja sekä valmistuminen että siivouksen vahvistus
hylättiin; pelkkä prosessin poistuminen ei kelvannut puhtauden todisteeksi.
Portin myöhempi KILL-kirjoitus epäonnistui katkenneeseen putkeen. Yritys
säilyy raakatallenteessa eikä ollut katkaisun käynnistävä tapahtuma.

Säilytetty journal oli RUNNING/OWNED/RECORDED ja sisälsi saman istunnon,
PREPAREDissa ilmoitetun työntekijän PID:n sekä täyden luontiajan. Luontiaikaa
ei varmennettu erillisellä Windows-kyselyllä. Uusi pinnattu tuotantobroker käytti koskemattoman journalin recover-polkua ja
palautti recovered/clean-kuitin vanhalle runNoncelle. Uusi normaali istunto
luki saman revision, paikan tunnisteen ja aktiivivalinnan levyltä sekä
vastasi shutdowniin. Sen työntekijä ja broker poistuivat koodilla 0.
Katkaistun työntekijän poistumiskoodia ei havaittu erikseen.

Riippumaton tarkastus purki molempien suuntien kaikki kehykset ja kahdeksan
pyyntö–vastausparia, vertasi loppukuitit, todelliset brokerien sulkeutumiset,
levyn tarkistussumman ja tarkan tilan sekä varmisti tyhjän sessions-hakemiston.
Kolme CLEAN/NONE-journal-kopiota ja nykyinen journal olivat samoja.
Käynnistystä ennen tarkistettiin suoritettavan moduulijoukon hashit,
pakettiresoluutiot ja suljetun runtime-paketin rakennuspinnit.

Varsinaisen recoverin Job-/kahva-/snapshot-haaraa ei havaittu erikseen;
PID-kyselyn poissaolo ei ratkaise sitä. Oikeuksien palautus ja profiilin
poisto perustuvat brokerin raakakuittiin ja katselmoituun lähteeseen,
eivät erilliseen Windows-inventaarioon. Tämä koe ei muuta varhaisten
snapshot-diagnoosien hylättyjä tuloksia eikä todenna luonnollista koko
snapshot-palautusta tai kuittaamattoman tallennuksen kaatumiskestävyyttä.

## T09u:n yhden istunnon tavu- ja lohkorajat

Yksi uusi normaali V2-istunto ylitti molemmat aiemmat kokonaisrajat:
sisemmissä APP-kehyksissä kertyi 135 695 476 JSON-body-tavua ja ulommassa
protokollassa 2 076 todellista CHILD_CHUNK-kehystä. Molemmat rajat täyttyivät
jo ennen shutdown-pyyntöä. OS:n data-eventtejä tai pyyntöjen lukumäärää ei
käytetty protokollalohkojen laskurina.

Istunto palautti 56 kokonaista taivasvastausta, jokaisessa 5 079 kohdetta.
Riippumaton suoratoistava raakapurku tarkisti kehysten otsakkeet, sekvenssit,
noncet, täsmälliset tavulaskurit, kaikki taivasvastaukset sekä 59 paritettua
RPC-pyyntöä. Molempien tavusuuntien hashit ja pituudet täsmäsivät, kirjoitusten
callbackit onnistuivat ja shutdown-vastaus edelsi lapsen syötteen sulkua.
Valmiita snapshot-olioita ei kerätty kasvavaan listaan. Levyjonon rajat
sisälsivät aktiivisen kirjoituksen; tuottajan pacing säilytti molemmat
normaalit heartbeatit.

Brokerin loppukuitti oli normal/clean ja ilmoitti workerin poistumiskoodiksi 0.
Myös brokerin todellinen exit/close oli 0. Vasta sulkeutumisen jälkeen luetut journalit
olivat kelvollisia, samoja CLEAN/NONE-tietueita ja sessions-hakemisto tyhjä.
Ohjelmapaketin lähde-, runtime- ja rakennuspinnit tarkistettiin erikseen.
Job-/ACL-/profiilisiivouksen näyttö perustuu brokerin kuittiin ja
katselmoituun lähteeseen; erillistä Windows-inventaariota ei tehty.

Ensimmäinen käynnistäjä hylkäsi kelvollisen loppukuitin, koska PowerShell
jäsensi ajan Decimal-tyypiksi ja tarkistus salli vain muut numerotyypit.
Alkuperäinen virhetulos säilytettiin, vaikka sen natiivihavainnot voitiin
varmistaa erikseen. Rajattu korjaus hyväksyy myös Decimalin ja hylkää
NaN-/Infinity-arvot muuttamatta aikarajoja, ajuria tai liikennemäärän ehtoja.
Uusi erillinen vahvistusajo läpäisi myös käynnistäjän ja riippumattoman
raakanäyttötarkastuksen. Automaattista uusintaa tai rajojen nostoa ei tehty.

Koe käytti vain synteettistä aineistoa ilman kielimallia, GPU:ta, GUI:ta,
MCP:tä tai APIa. Se todentaa yhden istunnon tavu- ja lohkorajojen ylityksen;
pitkän joutoistunnon näyttö on erillinen T09s-koe. Koko sovelluspakettia tai
verkkorajaa ei hyväksytä tämän osatuloksen perusteella.

## T09v:n käynnistyskorjaus ja normaali elinkaari

Run ja recover käyttävät nyt yhteistä `detached: true` -käynnistysasetusta,
jotta brokerin oma siivous ei riippuisi Noden ehdollisesta parent-Jobista.
Stdio-putket ja seurattu ChildProcess säilyvät; `unref()`-kutsua ei tehdä.
[Mekanismi ja rajat](../architecture/native-backend-runtime.md#brokerin-suhde-isäntäprosessiin)
erottavat tämän työntekijän varsinaisesta OS-eristyksestä.

Resurssisovittimen 31 kohdistettua testiä ja desktopin TypeScript-käännös
läpäisivät. Yksi tuore normaalikoe varmisti asetuksen palautusalustuksessa
sekä kahdessa oikeassa backend-istunnossa. Ensimmäinen tallensi ja aktivoi
synteettisen paikan revisioon 2, palautti 5 079 kohteen taivaan ja sulkeutui.
Toinen luki täsmälleen saman tilan ja sulkeutui normaalisti. Kaikkien kolmen
brokerin todellinen exit/close oli 0. Molempien tavusuuntien kehykset,
kymmenen RPC-paria, kirjoituskuittaukset ja shutdown-vastauksen järjestys
varmistettiin riippumattomasti. CLEAN/NONE-journalit, tyhjä sessions-puu ja
molemmat observing-tallenteet vastasivat nykyistä levytilaa.

Tämä koe varmistaa uuden asetuksen normaalin elinkaaren, ei Electronin
GUI:ta tai ympäröivästä Jobista irtautumista. T09u:n tavu- ja lohkorajakoe
tehtiin ennen käynnistyskorjausta; se ei ollut uuden asetuksen regressiokoe.

## T09t:n rajattu omistajakuolema

Ensimmäinen katkaisukoe epäonnistui: koetyökalun omistajaprosessi poistui
odotetusti, mutta tarkkailija ilmoitti vain yleisen virheen. Brokerin
poistumiskoodi ja ensisijainen siivousvaihe jäivät tuntemattomiksi.
Alkuperäinen aineisto ja sen RUNNING-journal säilytettiin muuttumattomina;
epävarmaa juurta ei palautettu tai korjattu käsin. Rajattu jälkikäteinen
lukukoe ei saanut prosessikahvaa eikä selvittänyt poistumiskoodia.

Lähdetarkistus tunnisti erikseen Noden ehdollisen parent-Job-liitoksen.
T09v:n käynnistyskorjauksen lisäksi koetyökaluun lisättiin rajatut erilliset
tallenteet ensisijaiselle virheelle ja sitä seuraavalle pakkosiivoukselle.
Tämä ei osoita ensimmäisen epäonnistumisen syytä. Uusi koe tehtiin vasta
lähde-, käännös-, syntaksi- ja normaalin elinkaaren tarkistusten jälkeen.

Yhdessä uudessa kokeessa vain kohdeistunnon omistajaprosessi katkaistiin.
Tarkkailija sitoi prosessit PID:n lisäksi täydelliseen luontiaikaan ja
brokerin ohjelmaidentiteettiin. Omistajan todellinen poistumiskoodi oli 91,
brokerin itsenäinen poistumiskoodi 1 ja tarkkailijan 0. Hätävahtia tai
brokerin ulkopuolista pakkopäättämistä ei tarvittu. Kohdebrokerin putkia
omisti vain katkaistu prosessi; ulkopuolinen lukija ei jatkanut niiden
tyhjentämistä.

Journal oli kelvollinen CLEAN/NONE ja sessions-hakemisto tyhjä jo ennen
myöhempää palautuskutsua. Tarkkailijan kohdekahvat sulkeutuivat ennen
suunniteltua tuoretta recover-kutsua. Sen jälkeen uusi backend luki saman
kuitatun revision, paikan ja aktiivivalinnan ja sulkeutui normaalisti.
Palautuskutsun ei siis väitetä tehneen kohdeistuntoa CLEANiksi.

Riippumaton tarkistus kattaa ennen katkaisua tallennetut rajatut
protokolla- ja tapahtumaetuliitteet, seitsemän pyyntö–vastausparia sekä
tuoreen status-/lukuvastaushaasteen. Etuliitteen näytteessä ei ollut
odottavia pyyntöjä; katkaisuhetken atomista tilaa ei havaittu. Normaaleja
health-ajastimia ei pysäytetty. EOF:n ja leasen keskinäinen syy, katkaisun
jälkeisten tavujen täydellisyys, workerin oma poistumiskoodi ja palautuksen
todistushaara säilyvät tuntemattomina. Job-/ACL-/profiilisiivouksen näyttö
on katselmoitu natiivipolku ja levyltä luettu lopputila, ei erillinen
Windowsin prosessi- tai käyttöoikeusinventaario. Alkuperäisen raportin
`recoveryRequiredAtTargetEnd: true` on alustuksessa asetettu tieto, jonka
uudelleenkäyttöpolitiikka ei täsmenny raportissa. Varovainen recover-portti
voi säilyä ilman luotettua kohdekuittia, vaikka journal on jo CLEAN.
Arvoa ei käytetä väittämään, että palautus korjasi likaisen journalin.

Koe käytti rajattua Node-isäntää ja synteettistä aineistoa ilman mallia,
GPU:ta, GUI:ta, MCP:tä tai APIa. Se ei hyväksy koko Electron-pakettia tai
selitä ensimmäisen epäonnistumisen syytä.

## T09w:n lukematon tulostekanava

Yksi tuore brokerin komponenttikoe käytti elossa pysyvää Node-raakaomistajaa.
Se käytti tuotannon käynnistysoptioita ja protokollaa, mutta ei Controllerin
tai NativeBackendPortin virhetilanteessa käynnistämää KILL-politiikkaa.
Muuttumattoman ohjaimen integraatiota ei siis tällä todennettu.

Seitsemän kuitattua käyttökyselyä tallensi ja aktivoi synteettisen paikan
revisioon 2 sekä palautti kokonaisen 5 079 kohteen taivaan. Molempien
kehystasojen ehjät etuliitteet ja tallennusjonojen valmistuminen tarkistettiin.
Koetyökalun vanhat pacing-jatkot poistettiin ennen stdout-lukijan pausea.
Sen jälkeen lähetettiin yksi saman välimuistikontekstin taivaspyyntö,
jonka kirjoituskuittaus onnistui. Normaalilla kahden sekunnin asetuksella
tehtiin vielä yksi ulomman heartbeatin ja yksi APP-pingin kirjoitusyritys.
Kaikkien 12 kirjoituksen callbackit ja write-returnit onnistuivat; vertaisen
lukemista ei tällä todisteta. Ajastimia ei pysäytetty puuttuvan vastauksen vuoksi.

Todellinen broker-exit oli 1 ilman signaalia, kun lukija oli edelleen pausessa.
Pausen ja synkronisen exit-havainnon välillä ei ollut resume-kutsuja,
resume-eventtejä, sovellukselle toimitettua lisädataa tai koetyökalun interventiota. Noden
exitin jälkeinen flushStdio ja rajattu loppuosan tyhjennys sallittiin vasta
havaitun prosessin päättymisen jälkeen. Tämä ei todista nollaa kernelin
esilukua. Myös todellinen close ja kaikkien stdio-putkien sulku varmistettiin.

Ennen suunniteltua CLEAN-recoveria journal oli jo alkuperäisessä kontekstissa
CLEAN/NONE, sessions olemassa ja tyhjä sekä levyn tila täsmälleen kuitattu
revisio 2. Palautuskutsu ja normaali restart säilyttivät samat tavut, paikan
ja aktiivivalinnan. Koko ajurin ja käynnistäjän todellinen poistumiskoodi oli 0.

Talteenotettu loppu jäi osittaiseksi: täyttä kohteen RESULT-kuittia ei ollut,
ja sekä ulommassa että sisemmässä kehystyksessä jäi keskeneräinen kehys.
Keskeneräinen vastauksen alku vastasi lämmitettyä taivasvastausta uudella
pyyntötunnisteella, mutta kokonaista vastausta ei saatu. Loppuosaa ei
resynkronoitu tai esitetty täydellisenä vastauksena. Capturejen valmistuminen
tarkoittaa tiedostojen viimeistelyä, ei ehjää protokollavirtaa.
Riippumaton purku tarkisti etuliitteen, tarkat loppuosat, kaikki kirjoitus-
ja tapahtumatallenteet sekä pause → exit → tyhjennys → close -järjestyksen.

Lähdekatselmus korjasi koetyökalun rajattujen siivousoperaatioiden seurannan,
mahdollisen ehjän loppukuitin ristiriitatarkistuksen ja tapahtumien semanttisen
uusintapurun. Ajuri odottaa myös myöhemmin rekisteröidyt siivousoperaatiot
alkuperäisen aikarajan sisällä. Tässä onnistuneessa ajossa terminal-input-
virhehaaraa tai ehjän RESULTin tarkistuspolkua ei käytetty.

Tulos on rajattu siivouksen valmistumiseen sovellustason tulosteenlukijan
ollessa pysähdyksissä todelliseen exitiin asti. Ensimmäinen watchdog-haara,
workerin riippumaton exit ja erillinen Job-/ACL-/profiili-inventaario jäävät
tuntemattomiksi. Kohteen siivousnäyttö on katselmoitu natiivipolku ja levytila.
Kielimallia, GPU:ta, GUI:ta, MCP:tä tai APIa ei ajettu eikä verkkorajaa kokeiltu.

## Avoin hyväksymisnäyttö

Varhaisen katkaisusarjan hyväksyntä, käyttäjäaineiston observing-migraatio sekä
pakettiversion vaihtaminen tarvitsevat vielä näytön. T09w:n raakaomistajan
komponenttinäyttö ei korvaa Controllerin tai graafisen Electronin integraatiota.
Myös muuttuneen ohjaimen graafiset MCP-regressiot ovat tämän osatuloksen
jälkeen uusittavaa tarkistusta.

Oikea CPU-malli, saman kokoonpanon verkkokielto, MCP:n natiivi eristys,
FMI-koetoiminto, GPU/ajotapavalinta ja lopullinen minimaalinen kokonaispaketti
säilyvät issue #10:n hyväksymisehdoissa. Monen istunnon yhteiskesto ei todista
yhden istunnon aikarajattomuutta. Raakadata, käyttäjä-/konetunnisteet ja
paikalliset polut säilyvät Gitin ulkopuolella.
