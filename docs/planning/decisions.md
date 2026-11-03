# Suunnittelun lähtökohdat ja avoimet valinnat

Tämä hakemisto kokoaa päätösten tilan. Kunkin aiheen tarkka sopimus
säilyy taulukon osoittamassa omistavassa dokumentissa.
Suunnittelusuunta ei tarkoita asennettua riippuvuutta tai todennettua toteutusta.

Projektin esittely ja yleinen vaihe ovat [READMEssä](../../README.md).
Etenemisjärjestys on [roadmapissa](roadmap.md), ja toteutustöiden tila sekä
valmistumisen näyttö GitHub-issueissa (repositoryn Issues).

## Suunnittelun lähtökohdat

| Aihe | Tila | Omistava dokumentti |
| --- | --- | --- |
| Ensimmäinen käyttöversio | Sovittu: kartta, keskusteleva katsaus, kohdetiedot, sää, paikat ja paikallinen historia. | [Tuoterajaus](../product/project-definition.md), [käyttötapaukset](../product/observing-session-use-cases.md) |
| Sovellus ja kerrokset | T02:n statusrunko toteutettu: Electron/TypeScript, React/Vite/CSS Modules, rakenne A ja main–backend-IPC. Laajemmat moduulit myöhemmin. | [Perusarkkitehtuuri](../architecture/base-architecture.md), [tekniikkasuunnitelma](../architecture/technology-and-ui-plan.md) |
| Mallimoottori | T03: node-llama-cpp 3.22.2 toimii UtilityProcessissa, 4B:n CPU-/CUDA-kehitysajot todennettu. Paketoitu ajo ja OS-eristys avoinna. | [Mallisuunnitelma](../architecture/local-model-plan.md) |
| Tähtilaskenta | T06: Astronomy Engine 2.1.19 ja HYG 4.1:n 5 070 tähden paikallinen aineisto; snapshot. T07 kytkee paikallisen Canvas-kartan ja kohdevalinnan nimettyyn IPC:hen. | [Laskentasopimus](../architecture/sky-calculation.md), [tähtikartta](../architecture/sky-map.md) |
| Mallit ja painot | Qwen3-4B Q4_K_M on otettu käyttöön projektin paikallisesta kansiosta. T04:n 4B/8B-vertailu on tehty; tulos ei vielä hyväksy kumpaakaan havaintoavustajaksi. Mallinvaihto asetuksista on sovittu myöhemmäksi toteutukseksi. Poro–Ministral-verrokit ovat mukana suunnitelmassa; tarkat paketit ja oletusmalli ovat avoimia. | [Mallivalinta ja toimitus](../architecture/local-model-plan.md) |
| Avustajan työnkulku | Sovittu: backend koordinoi, moduulit tarkistavat työkalut ja yksi opastajarooli toimii lähtötasona. Usean roolin hyöty mitataan erikseen. | [Orkestrointi](../architecture/assistant-orchestration-plan.md) |
| Verkon ja tiedostojen oikeudet | Sovittu tavoite: vain säätyöntekijän rajattu ulkoinen yhteys. OS-mekanismi, GPU ja eristyksen näyttö ovat avoimia; AppContainer/LPAC on vaihtoehto. | [Turvallisuus ja oikeudet](../architecture/security-and-permissions-plan.md) |
| Kehityksen MCP | Sovittu: rajattu stdio-yhteys ja asetusten kytkin, oletuksena pois joka käynnistyksessä. T05 toteuttaa Windowsin capability-kanavan ja omistajuuden tarkistukset. Codex-isännän erillinen käyttöönotto ja OS-eristys säilyvät erillisinä. | [MCP-sopimus](../architecture/local-model-plan.md#kehitys--ja-diagnostiikkarajapinta-paikalliseen-malliin) |
| Sää | Ilmatieteen laitos on valittu tarjoajaksi. Tarkka kysely ja kentät ovat avoimia; Open-Meteota ei toteuteta rinnalle. | [Sääpalvelu](../architecture/technology-and-ui-plan.md), [sään elinkaari](../architecture/data-lifecycle-plan.md) |
| Paikat, asetukset ja historia | Sovittu paikallinen säilytys: viimeisin paikka, säävalinta, käyttäjän poistoon asti säilyvät keskustelut ja viimeisin ennuste per paikka. Ensimmäinen säätila on manuaalinen. | [Tiedon elinkaari](../architecture/data-lifecycle-plan.md) |
| Testaus | Sovittu: pienet testit lähteen vieressä, laajat testit ja yhteiset aineistot tests/-puussa; paikalliset ajot ilman etä-CI:tä. Ensimmäinen näyttö on rajattu mallikoe. | [Testausohje](../ai/testing-rules.md) |
| Kehitystyö | Pääkehittäjä ja kriittisten muutosten tarkastaja on sovittu. GPT-mallien tehtäväkohtainen työnjako on suositus. | [Työohje](../../AGENTS.md#kehitystyön-roolit-ja-katselmus), [kehitysmallit](../ai/development-models.md) |
| Työskentelyskill | Luonnosta on kokeiltu T01:n rajauksessa; laajempi toimivuus ja asennus ovat todentamatta. | [task-start-finish](../ai/skills/task-start-finish/SKILL.md) |

## Ennen riippuvaa toteutusta ratkaistavat asiat

- Ensimmäisen kokeen [paketit, työkaluketju ja Windows-kehitysoikeudet](../experiments/model-pilot.md) on määritelty. T03:n [4B-moottorikoe](../experiments/model-runtime-probe.md) todentaa asennuksen ja CPU-/CUDA-ajon; T04:n [4B/8B-vertailu](../experiments/model-comparison.md) on tehty,
  mutta laatu ei riitä havaintokäytön hyväksyntään.
- Varhaisen ja lopullisen kokoonpanon OS-turvanäyttö; muiden malliperheiden tarkat paketit.
- Laajemmin tuettu Windows-/CPU/GPU-kokoonpano; T03:ssa CPU ja CUDA valitaan näkyvästi ilman hiljaista fallbackia.
- T06:n [tähtilaskenta](../architecture/sky-calculation.md) käyttää Astronomy Engine 2.1.19:ää ja HYG 4.1:n paikallista mag≤6-aineistoa. FMI-kysely ja käynnistyskatsauksen aikarajat ovat avoimia.
- Mallivalinnan ja mallikansion muistaminen sekä puuttuvan mallin käsittely.
- Tallennuksen tekninen toteutus; MCP:n OS-oikeusrajan ja paketoidun ajon näyttö.
- Ensimmäinen synteettinen aineisto on [kokeen lähtötiedoissa](../experiments/model-pilot.md); T04:n tulokset ovat [vertailuraportissa](../experiments/model-comparison.md). Suorituskyvyn hyväksyttävät rajat ja luotettavan havaintoavustajan mallivalinta ovat avoimia.
- Horisonttiesteiden ja havaintovälineiden tietojen tarkempi käyttötapa.

Ensimmäisen mallikokeen rajaus ja lähtötietojen tarkistus kuuluvat T01 / #2:een.
Projectsia tukevan kehitysyhteyden käyttöönotto on T00 / #1.
Tässä ei ylläpidetä näiden tehtävien elävää tilaa.

Vienti ja palautus, havaintopäiväkirja sekä laajemmat kohde- ja välinetoiminnot
säilyvät myöhemmiksi rajattuina. Toteutuksen aloitus on valtuutettu;
asennukset ja ajot tehdään rajattujen toteutusissueiden kautta.
Muut projektit pysyvät tarvittaessa luettavina vertailuina.
