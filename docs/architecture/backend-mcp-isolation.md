# Backendin ja MCP:n eristyksen toteutuspolku

Tila: Astran rajaama jatkosuunnitelma issueen #10. Tämä dokumentti ei ole
ajonaikainen hyväksyntä. Oikeusmatriisin omistaa
[turvallisuussuunnitelma](security-and-permissions-plan.md), mallin nykyisen
sovittimen [natiivin mallin sopimus](native-model-runtime.md).

## Lähtökohta ja ehdokas

Backend toimii nyt Electron UtilityProcessissa. Sen entrypoint käyttää
process.parentPortia, cwd:tä havaintopaikkojen datajuurena ja entrypointiin
suhteutettua katalogipolkua. Backend välittää mallityöt mainille; sen
käyttöpolku ei tarvitse SDK:ta tai omien lapsiprosessien käynnistystä.
MCP toimii tavallisessa Nodessa ja lukee connection.jsonin desktop-datan
mcp-alihakemistosta. Sovellusprotokollan oikeusrajat on testattu, mutta
näiden kahden prosessin OS-rajoja ei ole vielä todennettu.

Ensimmäinen ehdokas on projektissa jo lukittu virallinen Node 24.22.2,
jonka natiivi käynnistäjä avaa rajatuilla oikeuksilla ja valmiilla stdio-
putkilla. Eristetty Node-koepääte ei kutsu child_process.spawn/forkia tai SDK:ta.
Tämä erottaa aiemmin todetun libuvin lapsiputkiongelman uudesta kuljetuksesta.
Toimivuutta ei päätellä tästä erosta; se mitataan.

Noden julkaisuindeksin tarkistus 5.11.2026 näyttää nykyisissä v24/v26-
julkaisuissa edelleen libuv 1.52.1:n. Pelkkä version vaihto ei ole näyttö
korjauksesta. Oma korjattu Node säilyy tutkimusverrokkina, eikä sitä valita
toimitettavaksi riippuvuudeksi. Virallisen Noden käyttö sovelluksessa olisi
erillinen toimitettava runtime; alkuperä, päivitysvastuu, lisenssit ja koko
paketin riippuvuudet on silloin hyväksyttävä toimitusvaiheessa.

## Ensimmäinen työpaketti: synteettinen stdio-käynnistys

Sol toteuttaa ensin pienen kokeen tests/e2e/isolation/-puuhun. Sovelluksen
nykyistä käynnistystä ei vaihdeta tämän kokeen valmistelussa.

- Käynnistäjä sallii vain oman lukitun Node-binäärin, yhden kiinteän JS-
  koepäätteen ja suljetut tapaukset. Ei vapaata komentoa, skriptiä tai Node-optioita.
- Virallisen arkiston tarkiste tulee nykyisestä työkalulukosta. Puretun
  node.exe:n eheys johdetaan tarkistetusta arkistosta ja sen oma SHA-256
  kirjataan koemanifestiin.
  Koe tarvitsee vain oman tavallisista tiedostoista kopioidun minimipaketin.
  Mallipainoja, käyttäjätietoja, SDK:ta tai node_modules-puuta ei kopioida.
  Kiinteät --preserve-symlinks ja --preserve-symlinks-main säilyttävät aiemman
  kokeen lataustavan; koepaketin oma minimaalinen package.json katkaisee
  pakettikontekstin haun. Koko koepuu tarkistetaan ilman symbolisia linkkejä.
- Jokainen tapaus saa oman merkityn juuren ja profiilin. Paketti on luettava,
  scratch kirjoitettava ja synteettinen private-aineisto oikeuksien ulkopuolella.
  Linkit, muuttuneet tarkisteet ja ylimääräiset tiedostot hylätään ennen grantteja.
- Käynnistyslipun ehdokas ja sen näyttöraja ovat
  [konsolihavainnon jatkossa](#ensimmäisen-toteutuksen-konsolihavainto-ja-rajattu-diagnoosi).
  Lippuja ei yhdistetä tai vaihdeta automaattisesti. Vain nimetyt
  stdin/stdout/stderr-kahvat periytyvät.
  Konsolin puuttuminen ja Jobin ainoa jäsen tarkistetaan myös ajossa.
  Ympäristö rajataan käynnistäjässä ennen Noden ensimmäistä käskyä; esimerkiksi
  NODE_OPTIONS, NODE_PATH ja inspector-asetukset eivät periydy.
- Job: yksi prosessi, yksi suoritin, BelowNormal, enintään 512 MiB commit.
  Yksi tapaus kestää enintään 20 sekuntia. Nämä ovat kokeen rajat, eivät
  lopullisen backendin suorituskykyvaatimukset. Muistirajan virhe kirjataan.
- Kontrollin jälkeen kokeillaan LPAC + registryRead -ehdokasta. Capabilityn
  täsmällinen SID-joukko, profiili, integrity, Job ja kahvojen perintä luetaan
  takaisin ennen työntekijän jatkamista. registryRead ei ole vain yhden
  katalogiavaimen oikeus; sen kattavuus on kuvattava ennen tuotantovalintaa.
  AC on erillinen diagnoosiverrokki, ei automaattinen varareitti.
- Stdio käyttää rajattua tavukehystystä ja tiukkaa UTF-8:aa. Kokeen kehys
  enintään 16 KiB, enintään 20 kehystä ja 64 KiB yhteensä kumpaankin suuntaan.
  stderr on erillinen enintään 16 KiB:n diagnostiikka, ei tilakuittien lähde.
- Mainin omistajakanava, Job ja yksityinen sentinel eivät periydy työntekijälle.
  Työntekijän sisältö ei saa esiintyä käynnistäjän identiteetti- tai siivouskuittina.

Koe alkaa kontrollin, AC:n ja LPAC-ehdokkaan normaalilla ping/pong- ja
lopetuksella. Näiden toimiessa tehdään hallittu JS-virhe ja omistajan
katoaminen kontrollissa ja LPAC-ehdokkaassa: seitsemän perusmatriisin tapausta. Ensimmäinen odottamaton
virhe pysäyttää sarjan; epäonnistunut tapaus ja ajamatta jääneet erotellaan.
Jokainen ajo tarkistaa paketin luvun, scratch-kirjoituksen, private-luvun ja
-kirjoituksen sekä koodin kirjoittamisen. Kontrollissa nimetyt operaatiot
onnistuvat, eristetyssä profiilissa vain sallitut. Erillinen synteettinen
AAP-lukufixture erottaa AC:n ja LPAC:n odotukset. Suoran LPAC-tokenlipun
null/87/0-havainto säilytetään tuntemattomana, vaikka muu näyttö läpäisisi.

Perusmatriisin lisäksi hyväksyntä vaatii katkenneen/ylipitkän/virheellisen viestin hylkäyksen,
lukematta jätetyn putken aikarajan, käynnistysvirheen ja omistajan katoamisen
ennen readyä. Nämä eivät kaikki vaadi Windows-ajoa: parseri ja tilakone
varmennetaan kevyesti, prosessien sulku ja putken jumittuminen oikealla ajolla.
Pelkkä valmis-viesti, timeout tai käynnistäjän exit 0 ei riitä. Työntekijä ja
broker ovat poistuneet, Job on tyhjä, profiili poistettu ja oma työtila
siivottu ennen onnistumista. Epävarma siivous säilyttää aineiston ja estää
sen työjuuren uudelleenkäytön.

Aiempi T09a on todentanut nimetyn natiivikokoonpanon verkkokieltoja;
sitä ei siirretä uuden Node-prosessin näytöksi. Tässä kokeessa ei tehdä
verkkoyrityksiä. networkVerified pysyy false-arvossa.
Tuloksena on vain konsolittoman käynnistyksen, stdion, tiedostojen ja
elinkaaren näyttö; #10:n verkko- tai kokonaispakettiruutuja ei merkitä valmiiksi.

## Ensimmäisen toteutuksen konsolihavainto ja rajattu diagnoosi

Käynnistimen ja tavuprotokollan ensimmäinen toteutus on paikallisessa kokeessa.
CREATE_NO_WINDOW-kontrolli pysähtyi ensin brokerin perittyyn konsoliin.
Broker irrotettiin vain omasta konsoliyhteydestään säilyttäen kolme
standardiputkea. Ensimmäisen ajon lapsi oli jo luotu suspendattuna;
käynnistyskuitin puuttuminen ei tarkoita lapsiprosessin puuttumista.

Uusinta todensi konsolin puuttumisen ennen lapsen jatkamista, Node-version,
ready-viestin ja kuusi kontrollin tiedostohavaintoa. Ready-vaiheen jälkeen
konsoliin pystyi kuitenkin liittymään. Koe hylättiin ja Job siivottiin;
AC- ja LPAC-tapauksia ei ajettu. Node-koodin omaa AllocConsole-kutsua ei
osoitettu. Konsoli-istunnon puuttuminen ja ikkunan puuttuminen erotetaan.

Astran katselmus rajasi seuraavaksi yhden erillisen DETACHED_PROCESS-
kontrollidiagnoosin. Se ei ole automaattinen varareitti tai matriisin jatko:

- Erillinen `-DetachedControlDiagnostic`-rakennus ja koetarkisteet; ainoa
  lapsen käynnistyslipun muutos on CREATE_NO_WINDOW → DETACHED_PROCESS.
- Binääri ja ajuri sallivat vain control/normal-tapauksen. AC/LPAC-ajo
  vaatii uuden hyväksytyn päätelmän tuloksesta ja oman näyttönsä.
- Virallinen Node, koodi, kolme standardiputkea, ympäristö, Job, kuorma-
  ja viestirajat sekä synteettinen aineisto säilyvät samoina.
- Konsolitarkistus tehdään ennen resumea ja ready-viestin jälkeen.
  Onnistuva AttachConsole hylkää yhä kokeen; piilotettu ikkuna ei riitä.
- Ping/pong, enimmäiskehys, EOF-sulku, prosessien poistuminen ja oma
  siivous vaaditaan. Aiemmat epäonnistuneet raportit ja työtilat säilyvät.

Yksi DETACHED-kontrolli läpäisi: pieni ja enimmäiskokoinen viesti,
EOF-sulku, kuusi kontrollin tiedostohavaintoa sekä konsolin puuttuminen
ennen resumea ja ready-viestin jälkeen varmennettiin. Lapsi ja broker
poistuivat, Job tyhjeni ja oma työtila poistui. Riippumaton Astra-katselmus
varmisti lähde-/binäärisnapshotin, virallisen Node-arkiston ja raakanäytön.
Tämä yksittäinen kontrolli ei hyväksy AC/LPAC- tai verkkorajaa.

Astran tarkentama seuraava portti on erikseen tunnistettu
`-DetachedCandidate`-rakennus. Binääri ja ajuri sallivat vain kolme
normaalitapausta: control/normal, ac/normal ja lpac/normal. Muut oikeus-,
kahva-, kuorma-, konsoli- ja siivousehdot säilyvät. Ensimmäinen epäonnistuminen
pysäyttää sarjan; diagnoosirakennusta tai CREATE_NO_WINDOW-polun tulosta ei
käytetä automaattisena varareittinä. Virhe- ja sulkuvariaatiot lisätään vasta
näiden normaalitapausten näyttökatselmuksen jälkeen omana tarkennuksena.

Kolme DETACHED-normaalitapausta läpäisivät erillisessä sarjassa. Kontrollissa
kaikki kuusi tiedostotoimintoa onnistuivat; AC:ssa private-luku/-kirjoitus ja
koodikirjoitus estyivät, LPAC-ehdokkaassa myös AAP-luku. Molempien rajoitettujen
tapausten suora LPAC-lippukysely säilyy null/87/0-havaintona. Riippumaton
Astra-katselmus varmisti lähteet, binäärit, raakanäytön ja omat siivoukset.

Seuraava erillinen `-DetachedMatrix`-rakennus rajataan täsmälleen 15
suunniteltuun yhdistelmään: AC vain normal, kontrolli ja LPAC kukin seitsemän
nimettyä tapausta. Se ei avaa 21 yleistä yhdistelmää. Ajuri pysähtyy edelleen
ensimmäiseen odottamattomaan virheeseen. Owner-loss tarkoittaa tässä
omistajakanavan stdin-yhteyden katkaisua, ei omistajaprosessin pakkotappoa.
15 tapauksen sarja on läpäissyt; menetelmän ja näyttörajan omistaa
[Node-stdio-koe](../experiments/node-stdio-probe.md). Lopullinen riippumaton
raakanäyttökatselmus ja osavaiheen hyväksyntä kirjataan issueen #10.
Verkko ei kuulu tähän kokeeseen.

Tavallinen sovellus ja natiivin mallin ajotapa eivät vaihdu koevaiheen
perusteella. Ajantasainen tulos ja alkuperäisten hyväksymisehtojen tila
kirjataan issueen #10; raakadata jää paikalliseksi.

## Jaetun käynnistimen muutosraja

Nykyinen packages/windows-runtime/native/isolated-launcher.h on natiivin
mallin sopimus: capabilityt=0, DETACHED_PROCESS, stdio=NUL ja erillisten
putkikahvojen numerot argv:ssä. Node-kokeen politiikkaa ei lisätä hiljaisesti
mallin oletuksiin. Käytä erillistä koekoostetta; mahdollinen yhteinen apu
irrotetaan vain selvästi nimetyllä sopimuksella ja kohdistetulla regressiolla.
Malliprofiilin nollacapabilityt, viestikanava ja kuittivaatimukset säilyvät.

## Seuraavat portit

| Portti | Toteutus ja hyväksyntä |
| --- | --- |
| Backendin käyttökelpoinen kuljetus | Erota runtime-koostaminen Electron-entrypointista. Mainin ChildPort-sovitin sovittaa uuden kanavan nykyisiin initialize/request/response/model-viesteihin. spawn tarkoittaa tarkistetun backend-lapsen käynnistystä ja pid sen tunnistetta; kill sulkee oman Jobin. Todellinen close/Job-siistiytyminen ratkaisee exitin; pelkkää worker-kuittia tai broker-exitiä ei mapiteta puhtaaksi poistumiseksi. Kuljetusvirhe käsitellään controllerin tuntemana sulkuna, ei käsittelemättömänä error-tapahtumana. |
| Backendin aineisto | Anna vain backendin oma datahakemisto kirjoitettavana ja koodi/katalogit luettavana. Käynnistäjä määrää polut; niitä ei hyväksytä rendereriltä tai mallilta. MCP:n bootstrap ja mallipainot jäävät tämän grantin ulkopuolelle. Testaa nykyisen observing-tallennuksen realpath, väliaikaistiedosto ja atominen korvaus; EPERM ei oikeuta laajaan asema-/repo-granttiin. |
| Backendin viestirajat | Määritä omat rajat todellisesta sopimuksesta. sky.snapshot sisältää 5 079 kohdetta: mallin 32 KiB:n kanavarajaa tai lyhyen kokeen rajaa ei kopioida siihen. Testaa suurin sallittu vastaus, ylikoko, osittaiset kehykset, vastapaine ja rajattu muistinkäyttö. |
| MCP:n käynnistys | Natiivi luotettu käynnistäjä omistaa stdion Codexiin ja rajatun yhteyden mainiin; eristetty Node palvelee vain MCP-protokollaa. Selvitä kahden kanavan välitys erillisellä kokeella ennen nykyisen bridge-polun muutosta. |
| MCP:n aineisto ja valtuus | Älä anna koko desktop-datajuuren granttia connection.jsonin vuoksi. Tavoite on välittää vain kertakäyttöinen rajattu yhteyskäynnistys luotetulta välittäjältä; vaihtoehto on erillinen bootstrap-juuri omalla ACL:llä. Tarkka vaihtoehto ratkaistaan kokeen jälkeen. Käynnistäjän tulee tarkistaa yhteyden omistaja, tunniste ja sulku. |
| MCP:n elinkaari | Sekä sovelluksen sulku tai kehityskytkimen pois kytkentä että MCP-isännän stdion katkeaminen sulkevat omat prosessit. Kaikki neljä UI/MCP:n ristikkäistä luku-/peruutuskieltoa testataan uudelleen. Tavallista Node-sovitinta ei käytetä eristysvirheen varareittinä. |
| Verkkonäyttö | Eristetty backend ja MCP testataan ensin ilman FMI-poikkeusta: IPv4/IPv6, ulkoiset ja paikalliset kohteet sekä nimenselvitys. Kontrolli ja käyttöjärjestelmätason eston näyttö vaaditaan; timeout ei todista kieltoa. |
| FMI ja kokonaispaketti | Säätyöntekijän tarkka ulospääsy, GPU-profiilit, mainin hyväksytty luottamusraja ja koko koepaketti jäävät erillisiksi porteiksi. Yleinen internet-capability ei ole FMI-rajaus. |

MCP:n nykyinen named pipe ja yhteyskuvaus eivät sellaisenaan osoita uuden
profiilin yhteensopivuutta. Nimettyjen putkien ACL ja nimiavaruus, asiakkaan
tunnistus sekä putken sulkeutuminen testataan käytetyllä Windows-profiililla.
Kehitysyhteyden avaaminen ei anna backendin data- tai asetusoikeuksia.

## Työnjako ja hyväksymisnäyttö

Astra rajaa tämän suunnitelman ja tarkastaa prosessi-/oikeuspolitiikan.
Sol toteuttaa ensimmäisen stdio-kokeen ja sen paikalliset testit.
Erillinen tarkastaja vertaa lähteet, lukitut binäärit, raakakokeet ja
siivousnäytön. Epäonnistunut koe palautetaan rajattuun diagnoosiin;
toteutusta ei automaattisesti laajenneta omaksi Node-haaraksi tai koko
backendin siirroksi. Ajonaikainen hyväksyntä merkitään vasta tulosten jälkeen.

Koeraportit ja konekohtainen näyttö pysyvät .artifacts/-puussa. Julkiseen
issueen kirjataan menetelmä, koontitulokset, avoimet rajat ja mitatut tokenit.

## Lähteet

- [Nykyinen Node-julkaisuindeksi](https://nodejs.org/dist/index.json)
- [Noden AppContainer-lapsiputkien ongelma](https://github.com/nodejs/node/issues/66374)
- [Windowsin prosessinluontiliput](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)
- [Projektin aiempi runtimevertailu](../experiments/runtime-comparison.md)
- [Projektin aiempi Electron Node -koe](../experiments/electron-isolation-probe.md)

- [Windowsin konsolin luonti](https://learn.microsoft.com/en-us/windows/console/creation-of-a-console)
- [Microsoftin konsoli- ja ikkunakäynnistyksen suunnittelukuvaus](https://github.com/microsoft/terminal/blob/main/doc/specs/%23492%20-%20Default%20Terminal/spec.md)


Nykyisen backendin ensimmäisen synteettisen koetoteutuksen, resurssipaketin,
TBIP-viestirajojen ja sulun omistaa
[backendin eristyskoe](../experiments/backend-isolation-probe.md).
Tavallisen sovelluksen oletusajotapa ei muutu tämän osakokeen perusteella.


## MCP:n stream-koostamisen perusta

[Injektoitavien viestiyhteyksien osavaihe](../experiments/mcp-stream-composition.md)
erottaa nykyisestä yhteyskuvauksesta ja socketista jo autentikoidun
kehityskanavan sekä MCP:n oman stream-koostamisen. 49 yksikkötestiä ja kuusi
nykyisen ajotavan työpöytäregressiota läpäisivät; erillinen katselmus hyväksyi
rajatun lähdemuutoksen korjatun myöhäisen lukuvirheen jälkeen. Ehdokkaan
ulostulojono ja odotus on rajattu, mutta SDK:n parsittujen tuloviestien
kokonaisjono jää avoimeksi sisäänottorajaksi. Natiivia muxia, mainin
bootstrapia, LPAC-ajoa tai verkko-/tiedostorajaa ei tällä hyväksytä.
