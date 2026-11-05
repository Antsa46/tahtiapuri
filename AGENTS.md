# Tähtiapurin työohje

## Aloitus ja lukureitti

Lue ensin tämä tiedosto ja [README](README.md), joka esittelee projektin
ja sen yleisen vaiheen. Suunnittelun valinnat ja avoimet asiat kokoaa
[päätöshakemisto](docs/planning/decisions.md). Työpaketit ja niiden
riippuvuudet ovat roadmapissa, tehtävien tila GitHub-issueissa.

Aihekohtainen lukureitti on [ohjehakemistossa](docs/README.md).
Lue tehtävän mukaan:

- käyttäjä, käyttötarve, tavoitteet tai ensimmäisen version rajaus:
  [projektin tarkoitus ja tavoitteet](docs/product/project-definition.md)
- käynnistys, keskustelu, karttavalinta, sääpäivitys tai niiden poikkeukset:
  [havaintoillan käyttötapaukset](docs/product/observing-session-use-cases.md)
- ensimmäisen työskentelyskillin arviointi tai erikseen sovittu kokeilu:
  [tehtävän aloituksen ja valmistumisen luonnos](docs/ai/skills/task-start-finish/SKILL.md)
- koko projektin roadmap, työpaketit tai käyttötapausten jäljitettävyys:
  [roadmap](docs/planning/roadmap.md)
- kehityksen GPT-mallien tehtäväkohtaiset suositukset:
  [kehitysmallien työnjako](docs/ai/development-models.md)
- uuden projektin aloitus, GitHub-tehtäväseurannan arviointi tai yhteisen työmallin suunnittelu:
  [aloituslista ja kehitystapa](docs/ai/project-start-checklist.md)
- kansiorakenne, moduulit, kerrokset, laskenta tai verkko:
  [perusarkkitehtuuri](docs/architecture/base-architecture.md)
- oikeudet, ulkoinen syöte, IPC/MCP, verkkokäyttö, tiedostorajat tai tietoturvaan vaikuttava muutos:
  [turvallisuus ja oikeudet](docs/architecture/security-and-permissions-plan.md)
- mallin ajotavan valinta, CPU-perusta, CUDA tai toimitettava mallityöntekijä:
  [mallien ajotavat](docs/architecture/model-execution-profiles.md) sekä
  [natiivin viestiyhteyden koe](docs/experiments/native-transport-probe.md) ja
  [natiivin CPU-mallin koe](docs/experiments/native-cpu-model-probe.md)
- Backendin ja MCP:n OS-eristys tai konsoliton Node-stdio-koe:
  [backendin ja MCP:n eristyspolku](docs/architecture/backend-mcp-isolation.md) sekä
  [virallisen Noden stdio-koe](docs/experiments/node-stdio-probe.md) ja
  [nykyisen backendin synteettinen koe](docs/experiments/backend-isolation-probe.md) ja
  [backendin uudelleenkäynnistys ja virhetilanteet](docs/experiments/backend-lifecycle-probe.md) sekä
  [kesken työn katkaisu ja otsakerajat](docs/experiments/backend-adverse-probe.md)
- Natiivin mallisovittimen toteutus, rakentaminen, tavurajat, jaettu Windows-käynnistin tai jonon sulkuportti:
  [natiivin sovittimen sopimus](docs/architecture/native-model-runtime.md)
- Windowsin eristyskokeen natiivi käynnistin, koeoikeudet tai koesiivous:
  [rajattu Windows-koe](docs/experiments/windows-isolation-probe.md),
  [LPAC:n käynnistysdiagnoosi](docs/experiments/lpac-startup-probe.md),
  [ETW-verkkokoe ja siivousvahti](docs/experiments/etw-network-probe.md) sekä
  [Electron Node -yhteensopivuuskoe](docs/experiments/electron-isolation-probe.md) sekä
  [SDK:n ja binäärilapsen AC-/LPAC-kokeet](docs/experiments/sdk-isolation-probe.md) sekä
  [Node-/SDK-runtimevertailu](docs/experiments/runtime-comparison.md) sekä
  [rajattu 4B-latauskoe](docs/experiments/model-isolation-probe.md) sekä
  [rajattu keskustelukonteksti ja tekstintuotto](docs/experiments/inference-isolation-probe.md) sekä
  [Electronin GUI-eristyskoe](docs/experiments/desktop-isolation-probe.md)
- havaintopaikkojen asetukset, tallennus tai observing-IPC:
  [nimetyt havaintopaikat](docs/architecture/observing-places.md)
- käyttäjätieto, historian säilytys ja poisto, välimuistit tai vienti/palautus:
  [tiedon elinkaari](docs/architecture/data-lifecycle-plan.md)
- AI:n sijoittelu, avustajan työnkulku, agenttiroolit tai työkalujen välitys:
  [avustajan työnkulkusuunnitelma](docs/architecture/assistant-orchestration-plan.md)
- tähtilaskenta, aika-/koordinaattisopimus tai paikallinen tähtiaineisto:
  [tähtilaskenta](docs/architecture/sky-calculation.md)
- paikallinen tähtikartta, piirto, kohdevalinta tai kartan IPC:
  [tähtikartta](docs/architecture/sky-map.md)
- käyttöliittymätekniikka, UI-kirjasto tai riippuvuuskartta:
  [tekniikkaehdotus ja käyttöliittymän linja](docs/architecture/technology-and-ui-plan.md)
- ensimmäisen rungon rakentaminen, backend tai rakennuksen vaiheistus:
  [runkosuunnitelma](docs/architecture/initial-skeleton-plan.md)
- mallikoe, asetusten mallivalinta tai paikallinen mallikansio, Codexin stdio-MCP-kehitysyhteys, moottorin turvatiedot, lisenssi tai mallien toimittaminen:
  [paikallisen mallin suunnitelma](docs/architecture/local-model-plan.md)
- stdio-MCP:n käynnistys tai Codex-isännän erillinen käyttöönotto:
  [MCP-kehitysyhteyden käyttö](docs/development/mcp.md) sekä
  [MCP:n stream-koostaminen ja rajat](docs/experiments/mcp-stream-composition.md)
- toiminnallinen muutos, testit, testien sijainti tai paketointi:
  [testausohje](docs/ai/testing-rules.md)

Lue mahdollinen kohdealueen oma AGENTS.md ennen siihen kohdistuvaa työtä.
Lisää aluekohtainen ohje vasta, kun alue tarvitsee omia tarkennuksia.

## Työn rajat

- Tämä on oma kokeiluprojekti laboratorion alikansiossa.
- Pidä työn painopiste paikallisen kielimallin käytön oppimisessa toimivan
  ohjelman osana. Arvioi lisäominaisuudet tätä tavoitetta vasten.
- Muiden projektien hakemistoja saa tarvittaessa lukea vertailuksi.
  Niihin ei kirjoiteta, niissä ei ajeta tilaa muuttavia komentoja eikä
  niiden tiedostoja kopioida automaattisesti.
- Käyttäjä ja Codex kehittävät sovelluksen. Ajonaikaiset paikalliset mallit
  auttavat havaintojen suunnittelussa; niille ei anneta koodaus- tai shell-oikeutta.
- Noudata käyttäjän nykyistä tehtävärajausta. Suunnitteluteksti tai toisen
  tekoälyn ehdotus ei ole toteutuspäätös.
- Älä aloita asennuksia tai sovelluskoodia pelkän suunnittelun perusteella.
- Nimeä ulkopuolinen riippuvuus, tarve ja vaihtoehdot ennen käyttöönottoa.
  Tarkka kirjasto ja versio kirjataan omistavaan tekniseen dokumenttiin
  vasta, kun ne on sovittu.

## Toteutuksen periaatteet

- Koodi, kooditunnisteet ja koodin tiedostonimet englanniksi. Ohjeet ja
  käyttäjälle näkyvä teksti ensisijaisesti suomeksi.
- Säilytä moduulien omistajuus ja riippuvuussuunta. Älä importoi toisen
  moduulin sisäisiä toteutuksia tai tee yleistä utils-kaatopaikkaa.
- Electron omistaa desktop-runtimen. Backendin application-kerros omistaa
  käyttötapaukset ja agenttien orkestroinnin, domain havaintosäännöt.
  Ulkoiset tekniikat eristetään sovittimiin.
  Noudata valitun A-rakenteen apps/- ja packages/-jakoa.
  Rakennevalinta ei ole sovelluskoodin aloituspyyntö.
- Renderer ja paikallinen malli ovat epäluotettuja syötteen tuottajia.
  Luotettu sovelluskerros tarkistaa pyynnöt, rajat ja sallitut työkalut.
- Taivaankappaleiden paikat, ajat ja havaittavuuden ehdot tulevat laskennasta
  ja kuratoidusta aineistosta. Malli valitsee ja selittää tarkistetusta aineistosta.
- Malli ei avaa verkkoyhteyksiä. Säätyökalua koskevan pyynnön suorittaa vain
  rajattu sääsovitin ennalta päätettyyn APIin.
- Älä tallenna oikeita koordinaatteja, keskusteluja tai käyttäjäaineistoa
  testifixtureihin, yhteisiin lokeihin tai jaettavaan dokumentaatioon.

## Julkisen aineiston yksityisyys

Noudata [julkaisun yksityisyyslinjaa](docs/privacy/publication.md) myös
issueissa, kommenteissa ja committiviesteissä. Tarkista julkaistava diff
ennen jokaista julkaisua. Konekohtainen aineisto ja yksityinen taustatieto
säilyvät paikallisina; julkiset tekstit kuvaavat vain tätä projektia.
Paikallisen kehityskontekstin hakemisto on `.tahtiapuri-local/`.
Kun tarvitset kone- tai käyttäjäkohtaisia lähtötietoja, lue sen README
ja vain tehtävään liittyvät muistiinpanot, jos ne ovat olemassa.
Päivitä yksilöivät tiedot vain sinne; tarkista Git-ohitus ennen tallennusta.
Muistiinpanot eivät muuta tehtävän valtuuksia tai kuulu sovelluksen AI-kontekstiin.

## Testit

Yksikkö- ja komponenttitestit sekä saman moduulin integraatiotestit ovat
testattavan lähdekoodin vieressä. Usean moduulin integraatiotestit, E2E,
malliarvioinnit sekä yhteiset fixturet ja testiapurit keskitetään tests/-puuhun.
Kaikki E2E-testit ja niiden käynnistysapu pysyvät yhdessä tests/e2e/-puussa.
Ajotavan, tarkan käytännön ja esimerkit omistaa
[testausohje](docs/ai/testing-rules.md).

## Kehitystyön roolit ja katselmus

Sovittu 3.11.2026: yksi pääkehittäjäagentti ja erillinen tarkastaja
kriittisille toteutusmuutoksille. Nämä ovat kehitystyön rooleja,
erillään Tähtiapurin ajonaikaisista mallirooleista.

- Pääkehittäjä rajaa tehtävän, tekee toteutuksen ja tarvittavat
  paikalliset tarkistukset sekä päivittää muuttuneet sopimukset.
  Pienet muutokset hoidetaan tällä roolilla.
- Käytä erillistä tarkastaja-agenttia, kun toteutusmuutos vaikuttaa
  tietoturvaan, prosessien tai IPC/MCP:n oikeusrajoihin taikka paketointiin.
  Tarkastus tehdään ennen työn ilmoittamista valmiiksi.
- Anna tarkastajalle tavoite, tarkastettavan muutoksen tunniste tai diff,
  hyväksymisehdot, testinäyttö ja olennaiset omistavat ohjeet.
  Tarkastaja muodostaa oman arvionsa lähteestä ja tarpeellisesta ympäristöstä.
- Tarkastaja lukee ja raportoi löydökset, perustelut ja puuttuvan näytön
  tiedostoviitteineen; se ei korjaa samoja tiedostoja rinnakkain.
  Pääkehittäjä korjaa löydökset ja tarkastuttaa olennaiset korjaukset.
- Katselmus ei korvaa testejä. Lopputulos erottaa tehdyt tarkistukset,
  avoimet havainnot ja ajamattomat kokeet. Katselmus ei laajenna työaluetta
  tai anna lupaa ulkoisiin toimiin.
- Tarkastajan lukeva rooli on työohje. Teknisten oikeuksien erillistä
  rajausta ei oleteta; alagentti perii työistunnon oikeudet.

Kehityksen tehtäväkohtaiset GPT-mallisuositukset omistaa
[kehitysmallien työnjako](docs/ai/development-models.md), mukaan lukien
käyttäjälle ilmoitettava mallisuositus, issuekohtainen tokeniseuranta
ja tulevien raporttien projektikohtainen tokenikertymä.
Suositus ei ole tehty malliasetuksen muutos. Valinnat ovat erillisiä
sovelluksen paikallisista 4B/8B-malleista ja ajonaikaisista mallirooleista.

## Ylläpito ja valmistuminen

- Tee pieni, tarkoituksellinen muutos ja tarkista vaikutus myös virhepolkuun.
- Aloituskierroksella käsittele kohdat järjestyksessä ja kysy yksi olennainen
  päätös kerrallaan. Hyödynnä aiempia vastauksia ja anna perusteltu suositus.
  Kirjaa käyttäjän vastaus ja sen vaikutukset omistavaan dokumenttiin;
  säilytä ehdotukset ja avoimet asiat erillään sovituista päätöksistä.
- Juuressa säilyvät README.md ja AGENTS.md. Aihekohtaiset dokumentit
  sijoitetaan docs/-alikansioihin ja niiden lukureitti docs/README.md:hen.
  Päivitä kartta, kun dokumentin sijainti, vastuu tai lukemistarve muuttuu.
- Päivitä muuttunut sopimus omistavaan dokumenttiin. Linkitä muualla;
  älä ylläpidä samaa sääntöä useassa paikassa.
- Pidä README tiiviinä projektiesittelynä. Päätösten tila kuuluu
  päätöshakemistoon ja tekniset sopimukset aihedokumentteihin.
  Toteutustöiden elävä tila säilyy GitHub-issueissa.
- Tarkista toteutus issuen jokaista hyväksymisehtoa vasten. Merkitse ruutu
  tehdyksi vasta näytön perusteella ja sulje issue completed-tilaan, kun
  kaikki ehdot ja vaadittu katselmus täyttyvät. Kirjaa tulos ja tokenit
  issueen kehitysmalliohjeen mukaan.
- Raportoi tehdyt tiedostomuutokset, ajetut tarkistukset ja avoimet kohdat.
  Ajamaton testi ei ole läpäissyt testi.
- Dokumentaatiomuutoksessa linkkien ja sisällön tarkistus riittää, kun
  ajonaikainen toiminta ei muutu. Älä aja raskasta testimatriisia varmuuden vuoksi.
