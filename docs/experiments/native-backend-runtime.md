# Natiivibackendin ensimmäinen toiminnallinen koe

T09r ja T09s, issue #10:n osatuloksia. Natiivin backendin pohja toimii
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

## Avoin hyväksymisnäyttö

Vanhojen tavu- ja fragmenttikiintiöiden ylittävä yhden istunnon liikenne,
omistajaprosessin kuolema, kuuro tulostekanava, varhaisen katkaisusarjan
hyväksyntä, käyttäjäaineiston observing-migraatio sekä pakettiversion
vaihtaminen tarvitsevat vielä näytön.
Myös muuttuneen ohjaimen graafiset MCP-regressiot ovat tämän osatuloksen
jälkeen uusittavaa tarkistusta.

Oikea CPU-malli, saman kokoonpanon verkkokielto, MCP:n natiivi eristys,
FMI-koetoiminto, GPU/ajotapavalinta ja lopullinen minimaalinen kokonaispaketti
säilyvät issue #10:n hyväksymisehdoissa. Monen istunnon yhteiskesto ei todista
yhden istunnon aikarajattomuutta. Raakadata, käyttäjä-/konetunnisteet ja
paikalliset polut säilyvät Gitin ulkopuolella.
