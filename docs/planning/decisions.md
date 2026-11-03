# Suunnittelun lähtökohdat ja avoimet valinnat

Tämä hakemisto kokoaa päätösten tilan. Kunkin aiheen tarkka sopimus
säilyy taulukon osoittamassa omistavassa dokumentissa.
Suunnittelusuunta ei tarkoita asennettua riippuvuutta tai todennettua toteutusta.

Projektin esittely ja yleinen vaihe ovat [READMEssä](../../README.md).
Etenemisjärjestys on [roadmapissa](roadmap.md), ja toteutustöiden tila sekä
valmistumisen näyttö [GitHub-issueissa](https://github.com/Antsa46/tahtiapuri/issues).

## Suunnittelun lähtökohdat

| Aihe | Tila | Omistava dokumentti |
| --- | --- | --- |
| Ensimmäinen käyttöversio | Sovittu: kartta, keskusteleva katsaus, kohdetiedot, sää, paikat ja paikallinen historia. | [Tuoterajaus](../product/project-definition.md), [käyttötapaukset](../product/observing-session-use-cases.md) |
| Sovellus ja kerrokset | Sovittu suunta: Electron/TypeScript, React/Vite/CSS Modules, rakenne A ja main–backend-IPC. | [Perusarkkitehtuuri](../architecture/base-architecture.md), [tekniikkasuunnitelma](../architecture/technology-and-ui-plan.md) |
| Mallimoottori | Sovittu arviointisuunta: node-llama-cpp UtilityProcessissa. Tarkka build ja toimivuus ovat kokeella selvitettäviä; llama-server säilyy vaihtoehtona. | [Mallisuunnitelma](../architecture/local-model-plan.md) |
| Mallit ja painot | Sovittu 4B/8B-aloitus, ulkoinen mallikansio ja mallinvaihto asetuksista. Poro–Ministral-verrokit ovat mukana suunnitelmassa; tarkat paketit ja oletusmalli ovat avoimia. | [Mallivalinta ja toimitus](../architecture/local-model-plan.md) |
| Avustajan työnkulku | Sovittu: backend koordinoi, moduulit tarkistavat työkalut ja yksi opastajarooli toimii lähtötasona. Usean roolin hyöty mitataan erikseen. | [Orkestrointi](../architecture/assistant-orchestration-plan.md) |
| Verkon ja tiedostojen oikeudet | Sovittu tavoite: vain säätyöntekijän rajattu ulkoinen yhteys. OS-mekanismi, GPU ja eristyksen näyttö ovat avoimia; AppContainer/LPAC on vaihtoehto. | [Turvallisuus ja oikeudet](../architecture/security-and-permissions-plan.md) |
| Kehityksen MCP | Sovittu: rajattu stdio-yhteys ja asetusten kytkin, oletuksena pois joka käynnistyksessä. Todellinen yhteys ja oikeusrajat testataan. | [MCP-sopimus](../architecture/local-model-plan.md#kehitys--ja-diagnostiikkarajapinta-paikalliseen-malliin) |
| Sää | Ilmatieteen laitos on valittu tarjoajaksi. Tarkka kysely ja kentät ovat avoimia; Open-Meteota ei toteuteta rinnalle. | [Sääpalvelu](../architecture/technology-and-ui-plan.md), [sään elinkaari](../architecture/data-lifecycle-plan.md) |
| Paikat, asetukset ja historia | Sovittu paikallinen säilytys: viimeisin paikka, säävalinta, käyttäjän poistoon asti säilyvät keskustelut ja viimeisin ennuste per paikka. Ensimmäinen säätila on manuaalinen. | [Tiedon elinkaari](../architecture/data-lifecycle-plan.md) |
| Testaus | Sovittu: pienet testit lähteen vieressä, laajat testit ja yhteiset aineistot tests/-puussa; paikalliset ajot ilman etä-CI:tä. Ensimmäinen näyttö on rajattu mallikoe. | [Testausohje](../ai/testing-rules.md) |
| Kehitystyö | Pääkehittäjä ja kriittisten muutosten tarkastaja on sovittu. GPT-mallien tehtäväkohtainen työnjako on suositus. | [Työohje](../../AGENTS.md#kehitystyön-roolit-ja-katselmus), [kehitysmallit](../ai/development-models.md) |
| Työskentelyskill | Ensimmäinen luonnos on kirjoitettu; käytännön kokeilu ja käyttöönotto ovat tekemättä. | [task-start-finish](../ai/skills/task-start-finish/SKILL.md) |

## Ennen riippuvaa toteutusta ratkaistavat asiat

- Tarkat mallipaketit, kvantisoinnit, lisenssit, moottori- ja työkaluketjuversiot.
- Koeympäristö ja oikeudet sekä varhaisen ja lopullisen kokoonpanon turvanäyttö.
- Tuettu Windows-/CPU/GPU-kokoonpano ja näkyvä CPU-varatila.
- Katalogin rajaus, laskentasovitin, FMI-kysely ja käynnistyskatsauksen aikarajat.
- Mallivalinnan ja mallikansion muistaminen sekä puuttuvan mallin käsittely.
- Tallennuksen tekninen toteutus, MCP:n todentaminen ja resurssirajat.
- Malliarvioinnin aineisto ja suorituskyvyn hyväksyttävät rajat.
- Horisonttiesteiden ja havaintovälineiden tietojen tarkempi käyttötapa.

Ensimmäisen mallikokeen rajaus tehdään [T01 / #2:ssa](https://github.com/Antsa46/tahtiapuri/issues/2).
Projectsia tukevan kehitysyhteyden käyttöönotto on [T00 / #1](https://github.com/Antsa46/tahtiapuri/issues/1).
Tässä ei ylläpidetä näiden tehtävien elävää tilaa.

Vienti ja palautus, havaintopäiväkirja sekä laajemmat kohde- ja välinetoiminnot
säilyvät myöhemmiksi rajattuina. Sovelluksen toteutus ja malliasennukset
alkavat erillisestä toteutustehtävästä. EKYä käytetään vain luettavana vertailuna.
