# Ensimmäisen 4B/8B-mallikokeen lähtötiedot

T01 / [issue #2](https://github.com/Antsa46/tahtiapuri/issues/2), 3.11.2026.
Tämä dokumentti omistaa rajatun kehityskokeen toistettavat lähtötiedot.
Yleisen arviointikäytännön omistaa [testausohje](../ai/testing-rules.md),
oikeusrajat [turvallisuussuunnitelma](../architecture/security-and-permissions-plan.md).

## Tavoite ja rajaus

Selvitetään, tuottaako Qwen3 4B tai 8B sujuvan suomenkielisen katsauksen
ja tarkistettavan JSON-päätöksen samoista synteettisistä taivas- ja säätiedoista.
Sovittu: kehitys aloitetaan tästä kokeesta Electronin UtilityProcessissa.
Toteutuksen aloitus on valtuutettu; lähtötietojen valmistelu ei ole malliajon näyttö.

- **Sovittu:** 4B ja 8B vuorotellen, yksi ladattu malli, paikallinen aineisto.
- **Kokeella selvitettävä:** UtilityProcess + natiivikirjasto, CPU/CUDA, suomi,
  faktatuki, latenssi, muisti, peruutus ja sulku.
- **Avoin:** tuotantokäytön oletusmalli, suorituskyvyn hyväksyttävät rajat
  ja OS-eristyksen mekanismi.
- **Myöhemmäksi rajattu:** muut malliperheet, 14B, usean roolin vertailu,
  todellinen sää ja koko havaintokäyttöliittymä.

## Lukitut paketit ja asennusten sijoittelu

Koneellisesti luettava lähtötieto on
[pilot-manifest.json](../../tests/evaluations/local-model/pilot-manifest.json).
Se sisältää mallien täydet julkaisurevisiot, tiedostot, tavumäärät,
SHA-256:t, lisenssilähteet ja templatetarkisteen sekä pakettien versiot ja SRI:t.
Mallin latausosoite käyttää revision SHA:ta, ei liikkuvaa main-haaraa.

| Osa | Kokeen valinta | Tarve ja vaihtoehto |
| --- | --- | --- |
| Mallit | Qwen3-4B ja Qwen3-8B, Q4_K_M, Qwenin oma GGUF | Saman perheen kokoluokkavertailu. Poro ja Ministral myöhemmin. |
| Mallisovitin | node-llama-cpp 3.22.2 | TypeScript-rajapinta llama.cpp:hen; erillinen llama-server säilyy vaihtoehtona. |
| Natiivitausta | @node-llama-cpp/win-x64 ja win-x64-cuda, 3.22.2 | Erilliset CPU- ja CUDA-ajot; ei hiljaista vaihtoa. |
| Desktop | Electron 45.2.1 | Sovittu prosessirakenne; ei toista GUI-runtimea. |
| Rakennuksen Node | 24.22.2, Windows x64 ZIP | Projektikohtainen LTS-työkalu; käyttäjän yleistä asennusta ei korvata. |
| Työtila | pnpm 12.16.1 | Lukitustiedosto ja työtilan paketit; npm olisi vaihtoehto. |
| Kieli | TypeScript 7.0.2 | Sovittu kieli ja erillinen tyypintarkistus. |
| Paikalliset testit | Vitest 5.1.0 | Sopimusten ja moduulien testaus; Node-testiajuri olisi kevyempi vaihtoehto. |

Versiot tarkistettiin julkaisijoiden metatiedoista T01:ssä. T03:ssa 4B:n
CPU-/CUDA-yhteensopivuus on todennettu. T04:n erillinen
[4B/8B-vertailu](model-comparison.md) on tehty; se ei muuta tätä alkuperäistä lähtömanifestia.
[Toteutuneen moottorikokeen raportti](model-runtime-probe.md) omistaa
asennetun kokoonpanon ja ajon näytön. Manifesti säilyy alkuperäisenä lähtötietona.
CPU-paketin SRI ja Electronin Windows-runtime-ZIPin SHA-256 ovat manifestissa.
Transitiiviset riippuvuudet lukitaan asennuksessa. Natiivibinäärien sisäiset
build-tunnisteet ja paikalliset tarkisteet tallennetaan ennen ajoa;
paketin julkaisutarkiste ei korvaa tätä toteutuneen ajon näyttöä.
UI:n lisäpaketit valitaan T02:n tarpeen mukaan, niitä ei tarvita näiden syötteiden lukitsemiseen.

Kaikki kokeen asennukset jäävät Tähtiapurin omaan projektijuureen:
node_modules/, .local/toolchain/, .local/cache/pnpm/ ja .local/models/.
Koetilan työhakemisto on .local/pilot/; tulokset .artifacts/tests/evaluations/local-model/.
Nämä ovat Gitistä rajattuja polkuja. GGUF:t eivät kuulu Electron-asentimeen.
T01 ei lataa painoja tai asenna riippuvuuksia. T02/T03 hankkii vain tarvitsemansa
hyväksytyt paketit ja tarkistaa ladatut tiedostot paikallisesti ennen käyttöä.
Ennen ajoa kirjataan lopullinen lockfile, runtime- ja binääritarkisteet.
Tarkiste osoittaa vastaavuuden valittuun julkaisuun, ei haavoittumattomuutta.

Mallit ovat julkaisijan Apache-2.0-merkinnällä. Lisenssitekstien tarkisteet
ovat manifestissa. Mukana toimitettavien kirjastojen ja binäärien lisenssit,
aliriippuvuudet ja ilmoitukset kootaan käyttöönotossa ja viimeistellään T17:ssä.
Tämä ei valitse oman lähdekoodimme lisenssiä.

## Windows-kehityskokeen oikeudet

Käyttäjä hyväksyi 3.11.2026 rajatun kehityskokeen ennen AppContainer/LPAC-koetta.
Ajopolku on Electron main → backendin mallisovitin → UtilityProcess;
UtilityProcess lataa node-llama-cpp:n. Main ei itse tee inferenssiä.
Pyyntöjen jonotus ja tarkistus pysyvät backendissä.

Koe käyttää tavallisen käyttäjän oikeuksia, ei korotettua sovellusajoa.
Prosessien erottaminen ei estä käyttöjärjestelmätasolla tiedosto- tai
verkkopääsyä. Vain säätyöntekijä nettiin ei ole tämän kokeen todistettu ominaisuus.
Oikea sää, käyttäjän historia, tallennetut paikat ja muu yritysaineisto eivät kuulu kokeeseen.
Kehitysverkkohankinnat ovat erillinen valmisteluvaihe, eivät mallin työkaluja.
Malliajossa ei sallita automaattista latausta, lähdekäännöstä, URL- tai shell-työkaluja.
Puuttuva paketti päättää kokeen näkyvään virheeseen.
Lapsiprosesseille välitetään erikseen rajattu ympäristö, ei Codexin koko ympäristöä tai tunnuksia.
Ensimmäinen ajokoe tarkistaa myös omien prosessien sulkeutumisen.

OS-eristyksen näyttö tarvitaan erikseen T09:ssä ja lopulliselle kokoonpanolle
T16:ssa. Todellinen sääverkkokoe odottaa T09:n hyväksymisporttia.
Kehityskokeen hyväksyntä ei siirry EKYn tuotantoratkaisuksi.

## Aineisto, template ja suoritus

[Fixture](../../tests/fixtures/assistant/sky-weather.synthetic.json) sisältää
keksityt taivasarvot, nollakoordinaatit ja neljä säätilannetta.
Se ei ole tähtilaskennan vertailuarvo tai oikea sääennuste.
Tapaukseen välitetään yhteinen taivas ja vain valittu säävariantti.
[C01–C08](../../tests/evaluations/local-model/cases.json) kattavat katsauksen,
jatkokysymyksen, puuttuvan ja vanhan sään, puuttuvan luvun, epäluotetun
tekstin sekä sallitun ja kielletyn toimintopyynnön.
H01–H04 ovat erillisiä backendin validointisyötteitä, eivät mallin tuloksia.

Molemmat mallit käyttävät samaa
[järjestelmäohjetta](../../tests/evaluations/local-model/system-prompt.fi.txt).
GGUF:n tokenizer.chat_template tarkistetaan manifestin odotettua
UTF-8/SHA-256-arvoa vasten ja annetaan JinjaTemplateChatWrapperille asetuksella reasoning=false.
Templatea tai wrapperia ei vaihdeta hiljaisesti; poikkeama pysäyttää kokeen.
Manifestin muutokset versioivat kokeen uudeksi vertailuksi.

JSON-ajossa käytetään [päätösskeemaa](../../tests/evaluations/local-model/response.schema.json)
ja sitä seuraavaa merkityksen tarkistusta: kohde löytyy annetusta
fixturen luettelosta ja aika vastaa täsmälleen annettua hetkeä.
action=answer edellyttää tyhjiä targetId- ja atUtc-kenttiä.
Tarkistamaton vastaus ei suorita toimintoa.
Tämä on skeemaan rajattu päätöskoe, ei näyttö SDK:n natiivista function callingista.
Jälkimmäinen kirjataan erilliseksi ajotavaksi, jos sitä arvioidaan T04:ssä.

CPU ja CUDA ajetaan erillisinä kokeina. Jokaiselle malli/tausta-parille tehdään
yksi kirjattu lämmittely, sitten kolme toistoa tapausta kohti.
Kylmä lataus mitataan erikseen. Historia ja KV-konteksti ovat tapauskohtaiset;
mallin vaihdossa vanha malli puretaan ennen uuden latausta.
Konteksti on 4096 tokenia, tulostus enintään 512, temperature=0 ja seed=42.
Loput rajat ovat manifestissa; liian suuri syöte hylätään ennen generointia.
Aikakatkaisu tai keskeneräinen JSON on epäonnistunut tulos, ei hyväksytty vastaus.

## Tulosten kirjaus ja tämän vaiheen valmistuminen

Ajokohtainen JSONL tallentaa kokeen ja Git-version, syötetiedostojen
SHA-256:t, mallin paikallisen tarkisteen, templaten ja wrapperin,
lockfilen ja moottorin/binäärien tunnisteet, ajurin, todellisen ajotaustan,
generointiasetukset, tapaus-ID:n, toiston sekä aloitus- ja lopetusajan.
Mitataan lataus, ensimmäinen näkyvä vastaus, kokonaisviive, tokenit,
RAM-/VRAM-huippu ja palautuminen. Kirjaa mittarin lähde ja näytteenottoväli.
Puuttuva mittaus on null ja selite; WMI:n AdapterRAM ei kelpaa VRAM-huippumittariksi.
Erottele kylmä/lämmin ajo, kaikki toistot ja yhteenvetomediaani.

Jokaisesta tapauksesta säilytetään mallin vastaus, skeematulos,
merkitystulos, käsin tarkistettava faktatuki ja suomen ymmärrettävyys.
Tila on passed, failed tai not_run ja sille annetaan perustelu.
Generointisiemen ei lupaa bittitarkkaa toistettavuutta eri taustoilla.
Prosessien elinkaari ja MCP:n oikea stdio-koe raportoidaan T03/T05:ssä erikseen.
Synteettisetkin ajotulokset jäävät ensin paikallisiin artefakteihin;
julkiseen issueen kootaan tarvittava yhteenveto.

T01 valmistuu lähtötietojen, tiedostojen eheys- ja viitetarkistuksen
sekä skilliluonnoksen ensimmäisen rajauskokeilun perusteella.
Se ei todista mallin laatua, nopeutta, turvarajaa tai toimivaa sovellusta.
Skilliluonnosta ei tämän perusteella merkitä yleisesti asennetuksi tai toimivaksi automaatioksi.

## Julkaisijalähteet

Tarkistettu 3.11.2026. Tarkat revision- ja versiolinkit ovat manifestissa.

- [Qwen3-4B GGUF](https://huggingface.co/Qwen/Qwen3-4B-GGUF)
- [Qwen3-8B GGUF](https://huggingface.co/Qwen/Qwen3-8B-GGUF)
- [node-llama-cpp: Electron](https://node-llama-cpp.withcat.ai/guide/electron)
- [node-llama-cpp: CUDA](https://node-llama-cpp.withcat.ai/guide/CUDA)
- [Node 24.22.2 -tarkisteet](https://nodejs.org/dist/v24.22.2/SHASUMS256.txt)
