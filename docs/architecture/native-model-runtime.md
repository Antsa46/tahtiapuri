# Natiivin mallisovittimen viesti- ja sulkusopimus

Tämä dokumentti omistaa Electronin natiivin CPU-mallisovittimen toteutuksen.
[Ajotapasuunnitelma](model-execution-profiles.md) omistaa valinnat,
[turvallisuussuunnitelma](security-and-permissions-plan.md) oikeusrajat ja
[CPU-moottorikoe](../experiments/native-cpu-model-probe.md) moottorin alkuperän.
T09k liittää natiivin polun kehityssovellukseen. Koko #10:n verkko-, backend-,
MCP-, GPU- ja koepakettinäyttö on edelleen erillinen hyväksymisportti.

## Omistajuus ja lähteet

- `apps/desktop/src/main/native-model-host.ts` omistaa yhden työn run/cancel/stop-portin.
  Backend käyttää samaa porttia ja jonoa kuin aiemmin.
- `native-model-exchange.ts` tarkistaa pyynnöt, viestijärjestyksen ja loppukuitit.
  `native-model-protocol.ts` omistaa tavurajat, UTF-8:n ja suljetut tietuemuodot.
- `native-model-resources.ts` valmistelee ja tarkistaa oman kopion hyväksytyistä
  resursseista. `private-directory.ts` rajaa työjuuren käyttäjälle ja SYSTEMille.
- `apps/model-runtime/native/` sisältää sovelluksen C++-brokerin, työntekijän,
  suoran llama.cpp-C-rajapinnan ja mallikohtaisen promptin muotoilun.
- `packages/windows-runtime/native/` omistaa Windows-käynnistyksen, ACL:t,
  Jobin ja kehystyksen. Testien vanhat headerit ovat välittäviä includeja.

Sovelluskoodi ei sisällytä tests/-puuta tai testikomentoja. Vanha
node-llama-cpp-/UtilityProcess-sovitin säilyy erillisten kontrollifixtureiden
käytössä. Kehityksen main-entrypoint valitsee natiivin CPU-polun luotetusta
konfiguraatiosta. Renderer, backendin mallityö ja MCP eivät valitse
prosessin oikeusprofiilia. CUDA-pyyntö ei aktivoi tavallista ajotapaa.

## Yksi työ ja tuore konteksti

Yksi natiiviprosessi palvelee yhtä mallityötä, jonka jälkeen se suljetaan.
UI ja MCP käyttävät backendin yhteistä jonoa; niiden KV-konteksteja tai
malliprosesseja ei kierrätetä toisilleen. Main muodostaa oman satunnaisen
32 tavun istunnon ja kasvavat pyyntönumerot. Pyyntö ei sisällä komentoa,
polkua, verkkokohdetta tai eristysvalintaa.

Qwen3:n tarkisteella lukittu template renderöidään kahtena viestinä ilman
thinking-tuottoa. Luotetut roolirakenteet ja käyttäjäteksti tokenisoidaan
erikseen: käyttäjätekstillä special=false, rakenteella special=true, ja
mallin automaattiset erikoistokenit sallitaan vain ensimmäisessä kutsussa.
Koko valmis syöte lasketaan tokenirajaan ennen dekoodausta.
Sisäinen järjestelmäohje on tiivis englanninkielinen ohje suomenkieliseen
vastaukseen. Se ei anna työkalujen, levyjen tai verkon oikeuksia.

| Raja | Sopimus |
| --- | --- |
| Käyttäjäsyöte | Enintään 2 000 UTF-16-yksikköä ja 8 000 UTF-8-tavua; ei NULia tai virheellisiä surrogaatteja |
| Vastausteksti | Enintään 8 192 UTF-8-tavua; kelvollinen UTF-8, ei NULia |
| Konteksti | 4 096 tokenia; koko syöte enintään 3 072, tuotto enintään 512 |
| CPU | Yksi laskentasäie, batch ja microbatch 32, ei GPU-kerroksia |
| Brokerin tuloste | Enintään 32 tietuetta, 16 896 tavua rivillä ja 65 536 tavua yhteensä |
| Omistajakanava | Enintään 32 kehystä / 32 KiB, jono enintään kahdeksan kehystä |
| Worker-Job | Yksi prosessi, yksi suoritin, BelowNormal ja 6 GiB commit-raja |

Myös broker rajaa itsensä yhteen suorittimeen ja BelowNormal-prioriteettiin.
Valmistelu tarkistaa vähintään 6 GiB vapaata muistia. Rajat eivät takaa
lämpötilaa, vasteaikaa tai muiden sovellusten muistinkulutusta.

## Luottamus- ja tiedostorajat

Brokerin omat launched/result-tietueet erotetaan työntekijän frame-rungosta.
Mallin vastausteksti pysyy heksakoodattuna sisältönä; siitä ei muodostu
elinkaarikuittia. Koko tarkistetaan ennen heksadekoodausta ja UTF-8-tulkintaa.
Parseri sulkeutuu virheestä, ja host sulkee virheellisen ajotavan pysyvästi.
Virheilmoitus ei toista hylättyä tekstiä. Natiivin poikkeukset mapitetaan
suljettuihin vaiheavaimiin, eivätkä polut tai DLL-nimet kulje niiden mukana.

Työjuuri on mainin valitsema paikallinen hakemisto. UNC, reparse-pisteet,
kovat linkit, väärät koot ja muuttuneet tarkisteet hylätään. Jokainen työ
saa uuden merkityn hakemiston. Suljettu toimitusmanifesti sallii vain kaksi
omaa ohjelmaa ja neljä hyväksyttyä CPU-DLL:ää. GGUF kopioidaan erikseen.
Broker pitää mallin ja DLL:t kirjoitus-/poistojakoa estävissä lukituksissa
ja tarkistaa niiden tiivisteet ennen työntekijän käynnistystä.

`OwnerInput` lukee omistajaputkea yksin. Watchdog käyttää atomista
katoamislippua eikä lue samaa synkronista putkea. Lukijasäikeen sululla
on myös vahdista riippumaton aikaraja. Havaittu omistajan katoaminen
estää jatkamisen ennen valmistelua, sen jälkeen sekä ennen prosessin
luontia ja jatkamista. Valmistelu huomaa myös jonoon tulleen shutdownin.
Työntekijä saa vain nimetyt putkikahvat ja NULin; omistajakanava ja Job
sekä yksityinen sentinel-kahva eivät periydy sille.

LPAC-asetus pyydetään ilman capabilityjä ja token/Job/ACL tarkistetaan.
Suoran LPAC-lippukyselyn null/87/0-raja säilyy epävarmana. Oikean mallin
vastaus ei itsessään todista koko tiedosto- tai verkkorajaa.

## Aikakatkaisu, peruutus ja sulku

Jaettu MODEL_TIME_BUDGET määrittää mainin kokonaisajaksi 180 sekuntia,
myös valmistelu ja siivous mukaan lukien. Hallittu peruutus alkaa 170
sekunnissa, brokerin kova raja on viimeistään 175 sekunnissa ja viimeinen
mainin raja 180 sekunnissa. Valmistelun aika vähennetään brokerin budjetista.
Käyttäjän peruutukselle annetaan enintään viisi sekuntia ennen pakkosulkua.
Nämä ovat virhetilan ylärajat, eivät suorituskykytavoitteita.

Backend odottaa tulosta 185 sekuntia ja pyytää sitten peruutusta.
Kuittausta odotetaan vielä enintään 10 sekuntia. Jono ei vapaudu
ensimmäisessä aikakatkaisussa. Puuttuva kuittaus tai katkennut kanava
sulkee sovittimen pysyvästi; initialize ei elvytä sitä.

Peruutus käyttää tämän yhden työn prosessin shutdown-pyyntöä. Se kelpaa
ennen latausta, latauksessa, laskennassa ja valmiin vastauksen jälkeen.
Main sivuuttaa peruutuksen kanssa kilpailevan tekstin. Laskentasäie
liitetään ennen mallin vapautusta. Valmistelu odottaa myös oman apurinsa
todellista close-tapahtumaa; aikainen AbortError ei todista poistumista.

Normaali lopputulos hyväksytään vasta työntekijän bye-kuittauksen ja
poistumisen, tyhjän Jobin, poistetun profiilin, brokerin poistumisen sekä
valmisteluhakemiston poiston jälkeen. Osittainen tulosterivi, putken
lukuvirhe, väärä järjestys tai puuttuva kuitti estää hyväksynnän.
Siivous ei seuraa reparse-pisteitä; tarkistuspuulla on koko- ja syvyysraja.

Epävarma sulku säilyttää työtilan ja sulkee ajotavan. Myöhempi stop
ilmoittaa epävarmuudesta myös aktiivisen työn poistumisen jälkeen.
Uusi sovellusinstanssi ei aloita malliajoa, jos työjuuressa on vanha työtila.
Ohjelma ei poista sitä automaattisesti tai vaihda tavalliseen ajotapaan.
Mahdollinen palautus tarvitsee erillisen omistus- ja siivousvarmennuksen.
Kartta ja laskenta voivat toimia, vaikka malli ei olisi käytettävissä.

## Rakentaminen ja kokeet

Olemassa oleva lähteestä rakennettu CPU-runtime ja lukitut työkalut tarvitaan.
`build-model-runtime.ps1` kääntää vain pienet sovittimet yhdellä suorittimella,
tarkistaa lähteet ja DLL-kokonaisuuden sekä kirjoittaa toimitusmanifestin.
GGUF ei kuulu toimitusmanifestin mukana kopioitaviin binääreihin.
Lisenssi säilyy runtime-paketin licenses/-hakemistossa.

~~~powershell
powershell -NoProfile -File scripts/native/build-model-runtime.ps1
powershell -NoProfile -File tests/e2e/isolation/build-application-prompt.ps1
powershell -NoProfile -File tests/e2e/isolation/run-application-prompt-limited.ps1
powershell -NoProfile -File tests/e2e/isolation/run-native-application-limited.ps1
powershell -NoProfile -File tests/e2e/isolation/run-native-application-limited.ps1 -CancelOnComputing
powershell -NoProfile -File tests/e2e/isolation/run-native-desktop-limited.ps1
~~~

Promptikoe vertaa kahdeksan synteettisen syötteen C++-muotoilua GGUF:n omaan
Jinja-templateen ilman mallin lataamista. Varsinaiset malliajot käynnistetään
erikseen. Tavallinen nopea Playwright-kokoonpano ei aja niitä. Desktop-ajuri
luo uuden raporttijuuren; natiivin työdata pysyy Playwrightin automaattisesti
siivoaman output-hakemiston ulkopuolella. Epäonnistunutta vaihetta ei poisteta
uusinta-ajolla. Kaikki raakadata pysyy paikallisessa `.artifacts/tests/`-puussa.

## Näyttörajat

Suora NativeModelHost-koe on todentanut oikean 4B-vastauksen 4096-kontekstilla
sekä erillisen natiivin dekoodauksen peruutuksen. Normaali vapautus, Job-/
profiilisiivous, brokerin poistuminen, työtilan poisto ja alkuperäisen mallin
muuttumattomuus kuuluvat näihin onnistuneisiin kokeisiin. UI-/MCP-kokeet
kohdistetaan samaan sovittimeen erillisillä synteettisillä käyttäjätiedoilla.
Tarkat tulokset ja katselmukset ovat #10:ssä.

Aiempi ajurin virhe muutti havaittavan putken tekstiksi; havainnointi on nyt
erillisessä tavukopiossa. Alkuperäinen pitkä järjestelmäohje jäi yhdessä
normaalikokeessa aikarajaan ja työtila osittain jäljelle. Aikakatkaisun ja
siivousvirheen tarkkaa syytä ei eroteltu. Toinen toimiva vastaus jäi
fixturen liian tiukkaan pistevaatimukseen; sanavertailu sallii nyt vain
saman sanan valinnaisen loppupisteen. Vanhat epäonnistumiset säilyvät
sellaisinaan, eivätkä myöhemmät läpäisyt muuta niitä onnistuneiksi.

Koko sovelluksen OS-eristetty backend/MCP, FMI:n täsmällinen ulospääsy,
GPU-profiilit, lopullinen runtime-riippuvuuksien toimitus ja paketoitu
käynnistys tarvitsevat oman näyttönsä. Kehityksen DLL:t käyttävät vielä
olemassa olevaa MSVC-ajoympäristöä; erillisasennuksetonta toimitusta ei
väitetä valmiiksi. Tämä osuus ei sulje #10:tä.
