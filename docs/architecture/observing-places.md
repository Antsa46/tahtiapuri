# Nimetyt havaintopaikat

T08 toteuttaa UC-06:n paikalliset havaintopaikat. Tämä dokumentti omistaa
formaattivalinnan, observing-moduulin portin ja paikkojen toteutetun IPC-sopimuksen.
[Tiedon elinkaari](data-lifecycle-plan.md) omistaa käyttäjätiedon säilytysperiaatteet,
[tähtikartta](sky-map.md) piirron ja laskentakontekstin sekä
[turvallisuussuunnitelma](security-and-permissions-plan.md) yleisen oikeusrajan.

## Käyttäjän toiminnot

Asetusten Havaintopaikat-osassa käyttäjä lisää ja muokkaa nimettyjä paikkoja.
Paikka sisältää nimen, leveys-/pituusasteen, korkeuden metreinä ja IANA-aikavyöhykkeen.
Rajat tulevat domainista: leveys ±90°, pituus ±180°, korkeus −500…10 000 m.
Nimi normalisoidaan NFC-muotoon ja trimmataan; ohjausmerkit ja tyhjä nimi
hylätään. Enintään 64 UTF-16-koodiyksikköä nimeä kohti ja 16 paikkaa;
samannimiset paikat kirjainkoosta riippumatta hylätään.

Tallenna ja käytä paikkaa tallentaa sekä paikan että aktiivisen valinnan
samassa kirjoituksessa. Valitsimen paikanvaihto tallentaa uuden aktiivisen
id:n. Muokattava luonnos ei muuta karttaa ennen onnistunutta tallennusta.
Poista paikka pyytää valitun paikan poistovahvistuksen ohjelman omassa
näkymässä. Aktiivisen paikan poistaminen tyhjentää aktiivisen valinnan;
toista paikkaa ei valita huomaamatta.

Käynnistys lukee viimeksi käytetyn paikan, näyttää sen nimen ja laskee
nykyhetken kartan ilman mallia tai säätä. Kartan aika ei tallennu paikkoihin.
Ilman kelvollista aktiivista paikkaa kartta pyytää valitsemaan tai lisäämään sen.
Paikkapyynnön aikana kartan kontekstin ohjaimet ovat lukittuina. Vahvistetun
paikan vaihto sovitetaan näkymään ennen piirtoa ja säilyttää viimeisimmän
validoidun karttapyynnön UTC-hetken,
myös laskennan ollessa kesken. Paikallinen kellonaika ja UTC-poikkeama
lasketaan uuden paikan vyöhykkeellä. Vanha tulos mitätöidään ja vain uusin
jonotettu havaintokonteksti lasketaan edellisen karttapyynnön valmistuttua.

## Moduuli ja IPC

- Domain omistaa paikan tyypit, nimen ja havaintokoordinaattien säännöt.
- Backendin observing/application omistaa muutoksen ja revision;
  ports/places-repository on tallennusportti ja adapters/json-places-repository
  toteuttaa tiedoston. Composition valitsee sovittimen.
- Main omistaa datajuuren. Backend saa sen UtilityProcessin työhakemistona;
  observing käyttää vain kiinteää observing/places.json-alipolkua.
- Preload tarjoaa vain observing.read/save/remove/activate-operaatiot.
  Renderer ei anna tiedostopolkua, URL:ia, shell-komentoa tai kutsujaroolia.
- Main tarkistaa oman ikkunan pääkehyksen, URL:n, argumenttimäärän ja
  syöteskeeman. Backend tarkistaa istunnon, operaation, määräajan ja syötteen
  uudelleen. Vastauksen tarkat avaimet ja paikkojen viite-eheys validoidaan
  kuljetuksessa ja UI-asiakkaassa.

Save saa expectedRevisionin, uuden paikan luonnoksen ja joko null-id:n
(uusi paikka) tai olemassa olevan id:n. Id:n tuottaa backend. Activate/remove
saavat vain expectedRevisionin ja id:n. Read ei ota argumentteja.
Väärä revisio, tuntematon id ja ylimääräinen kenttä hylätään.

Main ja backend sallivat yhden observing-pyynnön kerrallaan, erillään
kartasta ja mallijonosta. Heartbeat ja sulku säilyttävät kapasiteettinsa.
Sulku estää uuden työn ja myöhäiset vastaukset sekä tarkistuksessa vielä
aloittamattoman commit-operaation. Jo aloitettu rename saa päättyä
atomisesti; sulku odottaa käynnissä olevaa observing-toimintoa normaalin
prosessin sulkubudjetin rajoissa. Määräaika tarkistetaan juuri ennen
commit-operaation aloittamista; aloitettua renamea ei peruta.

Avustajan tai MCP:n työkaluluetteloon ei lisätä paikkojen lukua tai muutoksia.
Oma validoitu UI-kanava on asetustoimintojen valtuusraja; se ei ole
tekninen todiste ihmisen fyysisestä napsautuksesta. Pysyvää muutosta ei voi
käynnistää mallin palauttamalla työkalutekstillä.

## Versioitu JSON ja kirjoituksen eheys

Pieneen paikkaluetteloon valittiin JSON. Uutta tietokantariippuvuutta ei
lisätä. Versio 1 sisältää schemaVersionin, state-olion ja SHA-256-tarkisteen.
State sisältää revision, places-listan ja activePlaceId:n. Aktiivisen id:n
pitää viitata olemassa olevaan paikkaan tai olla null. Id:t ja nimet ovat
yksilöllisiä; kaikki nimet, koordinaatit ja vyöhykkeet tarkistetaan myös
levyltä luettaessa. Tiedoston enimmäiskoko on 32 768 tavua. Tarkiste kertoo
satunnaisesta sisällön muutoksesta, ei aineiston aitoudesta tai salauksesta.

Tavallinen puuttuva tiedosto tarkoittaa tyhjää alkuasennuksen tilaa.
Vioittunut JSON, tuntematon versio, liian suuri tiedosto, väärä tarkiste,
virheellinen sisältö tai lukemisvirhe palauttaa READ_FAILEDin. Sellaista
tiedostoa ei korvata tyhjällä, eikä tallennus ohita epäonnistunutta lukua.
Automaattista tiedoston nollausta, tuontia tai vanhemman version arvaamista ei ole.

Kirjoitus etenee seuraavasti:

1. Lue ja tarkista nykyinen tiedosto sekä UI:n expectedRevision.
2. Kokoa seuraava täydellinen tila ja tarkiste; luo samaan hakemistoon
   satunnaisniminen uusi .tmp-tiedosto wx-tilassa.
3. Kirjoita koko sisältö, odota filehandle.sync ja sulje tiedosto.
4. Lue nykyinen tiedosto uudelleen ja vertaa sen raakasisällön tokenia.
   Tarkista myös ettei sulku tai määräajan päättyminen estä commitia.
5. Vaihda valmis väliaikaistiedosto places.json-nimelle yhdellä rename-operaatiolla.
   Onnistuminen palautetaan vasta operaation jälkeen.

Ennen vaihtoa viimeksi vahvistettuun tiedostoon ei kirjoiteta. Tavallinen
poikkeus siivoaa vain oman väliaikaistiedoston. Pakotettu prosessikatko voi
jättää .tmp-tiedoston; luku ei tulkitse sitä käyttäjätiedoksi eikä valitse
keskeneräistä tiedostoa. Katkon jälkeen käytössä on ennen commitia vanha
ja sen jälkeen uusi kokonainen tila. Tämä todennetaan oikealla lapsiprosessilla.

Pysyvyyslupaus koskee tätä prosessikeskeytyksen ja valmistuneen rename-operaation
rajaa. Hakemiston fsynciä, virtakatkoa, laiterikkoa tai tiedostojärjestelmän
omaa vioittumista ei ole todennettu; erillistä varmuuskopiointia tämä ei korvaa.
Node dokumentoi [syncin](https://nodejs.org/docs/latest-v24.x/api/fs.html#filehandlesync)
ja [rename-operaation](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisesrenameoldpath-newpath).

Sovellus käyttää yhtä mainin omistamaa backend-kirjoittajaa ja yhden instanssin
lukkoa. Revision ja file-token hylkäävät havaitut vanhat UI-pyynnöt sekä
lukujen välissä havaitut ulkoiset muutokset. Ne eivät muodosta atomista
compare-and-swapia toiselle ohjelmalle eivätkä estä saman käyttäjän vihamielisen
prosessin ajoittamaa tiedostovaihtoa. Usean itsenäisen kirjoittajan tuki ei kuulu T08:aan.

## Datajuuri ja virheestä palautuminen

Main varmentaa lähimmän olemassa olevan esi-isän ennen datajuuren luontia ja
valmiin juuren ennen forkia. Symbolinen linkki/junction, tavallinen tiedosto,
verkkopolku tai kanonisesta polusta poikkeava juuri hylätään. Repository
tarkistaa observing-hakemiston sekä places.jsonin tyypin, koon ja linkit;
hard-linkattu tiedosto hylätään. Tarkistukset rajaavat väärän polun käyttöä,
eivät muodosta käyttöjärjestelmän eristystä. Käyttöoikeusbitit eivät lupaa
Windowsin omistajakohtaista DACL-eristystä tai salattua tallennusta.

Tässä kehitysrungossa data on .local/data/desktop/observing/places.json-tiedostossa.
Testit käyttävät vain omia .artifacts/tests/-juuriaan. Kumpaakaan puuta ei
julkaista tai anneta mallin kontekstiksi. Paketoidun sovelluksen lopullinen
datajuuri ja OS-oikeuksien näyttö kuuluvat toimitus- ja eristystyöhön.

Luku-, tallennus-, konflikti- tai epävarma kuljetusvirhe ei korvaa viimeksi
vahvistettua paikkaluetteloa UI:ssa. Epävarmassa tilassa pysyvät muutokset
lukitaan ja kartan aktiivinen konteksti poistetaan, kunnes Lataa paikat
uudelleen palauttaa onnistuneen tilan. Muokkausluonnos säilyy. Muotovirhe,
samanniminen paikka tai täysi luettelo eivät mitätöi tunnettua hyvää tilaa.

Jos commit valmistuu mutta kuittaus katoaa, lopputulos voi olla uusi tila;
virhettä ei tulkita todisteeksi rollbackista eikä mutaatiota uusita automaattisesti.
Uusi luku selvittää tallennetun tilan ennen seuraavaa muokkausta.
Vioittuneen tiedoston korjaus ei sisälly UI:hin, mutta tiedosto säilytetään
ja onnistuneen korjauksen jälkeen lukua voi yrittää uudelleen. Käyttäjätietojen
vienti/palautus, keskusteluhistoria ja sääasetusten tallennus pysyvät erillisinä työpaketteina.

## Natiivibackendiin siirtymisen esivalmistelu

Issue #10:n `observing-migration.ts` sisältää puhtaan siirtosuunnittelijan.
Se saa lähteen ja kohteen tavusnapshotit, tarkistaa tämän dokumentin v1-muodon
ja palauttaa copy-, already-present-, no-source- tai blocked-suunnitelman.
Puuttuva tiedosto erotetaan vioittuneesta. Valmis kopiosuunnitelma omistaa
omat tavunsa ja säilyttää alkuperäisen revision, tunnisteet, järjestyksen,
aktiivivalinnan ja raakamuotoilun. Jo olemassa oleva kohde hyväksytään vain,
kun kelvolliset tavut ovat samat; ristiriitaa ei yhdistetä tai ratkaista
revision suuruudella.

Suunnittelijan 13 yksikkötestiä ja desktopin tyyppitarkistus läpäisivät.
Puhdas suunnittelija ei itse lue tai kirjoita tiedostoja. Sitä käyttävä
vartioitu siirtopolku on toteutettu ja testattu synteettisellä aineistolla
Windowsissa sekä Electronin käyttöliittymän kautta. Käyttäjäaineiston
käyttöönotto ja oletuspolun muutos odottavat koko hyväksymisporttia [natiivin backendin omistajuusrajan](native-backend-runtime.md#omistajuus-ja-kiinteät-juuret)
mukaisesti.

### Vartioitu siirto samassa broker-istunnossa

Siirtopolku toimii muuttumattoman kaatumispalautuksen jälkeen
ennen profiilin ja työntekijän luomista. Sama natiivi broker pitää vanhan
`observing/places.json`-lähteen ja sen esivanhemmat pinneissä koko siirron,
uuden backendin ajon ja varmennetun sulun ajan. Lähdekahva sallii vain
jaetun lukemisen. Se estää tunnetun vanhan tallentimen korvaavan rename-
commitin kahvan voimassa ollessa; hakemistokahva yksin ei estä puuttuvan
lapsitiedoston ensimmäistä luontia. Jakotilan ehdot perustuvat
[CreateFileW:n sopimukseen](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew).

Puuttuvan lähteen nimi voidaan varata `CREATE_NEW`-avauksella kirjoittamalla
kelvollinen tyhjä v1-tila ja varmentamalla flush sekä takaisinluku. Olemassa
olevaa lähdettä ei typistetä tai korvata. Tämä on nimenomainen muutos vanhaan
tallennusjuureen. Alkuperäinen puuttuminen kirjataan vain todetuksi historiaksi;
keskeytyksen jälkeen löytyvä tyhjä tiedosto ei yksin todista, kuka sen loi.
Tiedosto säilytetään ja validoidaan olemassa olevana tai epäselvä tila estetään.

Main validoi rajatut snapshotit tiukalla UTF-8-luvulla ja puhtaalla
suunnittelijalla. Natiivi säilyttää auktoritatiiviset tavut ja tiedostokahvat,
tarkistaa päätöksen ja molemmat tarkisteet, julkaisee kohteen korvaamatta
olemassa olevaa tiedostoa, lukee sen takaisin ja julkaisee lopuksi
omistajaan sekä juuri-identiteetteihin sidotun siirtomerkin. Julkaisun
korvaamattomuus käyttää [FILE_RENAME_INFO:n](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info)
`ReplaceIfExists=false`-ehtoa. Flush/takaisinluku eivät ole lupaus koko
siirron sähkökatkoatomisuudesta.

Valmis merkki sitoo säilytetyn vanhan lähteen identiteetin ja tarkisteen.
Jokainen käynnistys lukitsee lähteen ennen merkin tarkistusta. Uuden backendin
omat kelvolliset kohdemuutokset sallitaan; niitä ei verrata joka käynnistyksessä
alkuperäisen tuonnin tavuihin. Muuttunut vanha lähde, puuttuva tai vioittunut
valmis kohde ja virheellinen olemassa oleva merkki estävät käynnistyksen
säilyttäen molemmat aineistot. Jos merkki puuttuu mutta kohde on jo olemassa,
uudelleenyritys hyväksyy vain tavuilleen saman kelvollisen kohteen kuin
validoitu lähde. Puuttuva kohde voidaan kopioida alkuperäisen siirtopäätöksen
mukaisesti. Väliaikaistiedoston nimi
ei anna oikeutta sen käyttämiseen, ylikirjoitukseen tai poistamiseen.

Brokerin kaatuminen vapauttaa kahvat mahdollisesti ennen työntekijän
poistumisen valmistumista. Käytäntö ei todista kaikkien vanhojen prosessien
pysähtyneen tai estä kaikkea kaatumishetken päällekkäisyyttä. Seuraava ajo
todistaa työntekijän päättymisen nykyisellä recovery-polulla ja tarkistaa
lukitun vanhan lähteen uudelleen ennen uutta työntekijää. Sopimus koskee
tunnettua väliaikaistiedosto–rename-tallenninta; se ei laajenna tukea
mielivaltaisille vanhoille kirjoittajille tai saman käyttäjän vihamieliselle
prosessille.

Rajattu Windows-I/O-koe ja synteettinen Electron-siirtymä sekä restart
on todennettu. [Koeraportti](../experiments/native-backend-runtime.md#t09yn-vartioitu-siirto-ja-electron-siirtymä)
erottaa toteutuneen näytön katkaisu-, oikeus- ja kokonaispakettirajoista.
[Natiivibackendin sopimus](native-backend-runtime.md) omistaa siirron viestit
ja elinkaaren. Käyttäjäaineiston käyttöönotto ja oletuspolun vaihto ovat avoimia.
