# Dokumenttien lukureitti

[Projektin README](../README.md) esittelee Tähtiapurin ja sen yleisen vaiheen.
Suunnittelun valinnat ja avoimet asiat kokoaa
[päätöshakemisto](planning/decisions.md). Aihekohtaiset sopimukset ja
perustelut ovat alla nimetyissä omistavissa dokumenteissa.
Yhteiset työrajat ovat [AGENTS.md:ssä](../AGENTS.md).

Lue vain tehtävään liittyvät omistavat dokumentit. Kun tehtävä ylittää
vastuurajan, lue myös toisen osapuolen sopimus.

| Aihe | Omistava dokumentti |
| --- | --- |
| Julkisten tekstien yksityisyys ja paikallinen kehityskonteksti | [privacy/publication.md](privacy/publication.md) |
| Suunnittelun lähtökohdat, päätösten tila ja avoimet valinnat | [planning/decisions.md](planning/decisions.md) |
| Koko projektin vaiheet, työpaketit ja käyttötapausten jäljitettävyys | [planning/roadmap.md](planning/roadmap.md) |
| Kehityksen GPT-mallit, issuekohtaiset tokenit ja projektin kertymä | [ai/development-models.md](ai/development-models.md) |
| Käyttäjä, paikallisen mallin oppimistavoite, illan katsaus, rajaus ja työmäärän reunaehdot | [product/project-definition.md](product/project-definition.md) |
| Nykyhetken kartta, katsaus, keskustelun karttaohjaus, sääasetukset ja poikkeukset | [product/observing-session-use-cases.md](product/observing-session-use-cases.md) |
| Valittu kansiorakenne A, moduulit, kerrokset ja prosessien kulkureitit | [architecture/base-architecture.md](architecture/base-architecture.md) |
| Osien oikeudet, malliprosessin ajotapa ja eristyksen vaiheistus sekä Windows-/kontti-/VM-vertailu | [architecture/security-and-permissions-plan.md](architecture/security-and-permissions-plan.md) |
| Natiivin AppContainer/LPAC-kokeen rajaus, toistaminen ja rajattu näyttö | [experiments/windows-isolation-probe.md](experiments/windows-isolation-probe.md) |
| Electronin Node-tilan eristyskäynnistyksen synteettinen yhteensopivuuskoe | [experiments/electron-isolation-probe.md](experiments/electron-isolation-probe.md) |
| SDK:n CPU-alustus, riippuvuuksien kopiointi ja instrumentoidun binäärilapsen eristyskoe | [experiments/sdk-isolation-probe.md](experiments/sdk-isolation-probe.md) |
| Havaintopaikkojen asetukset, viimeksi käytetty paikka ja observing-IPC | [architecture/observing-places.md](architecture/observing-places.md) |
| Käyttäjätiedot, keskusteluhistoria ja mallin konteksti, poisto, välimuistit ja vienti/palautus | [architecture/data-lifecycle-plan.md](architecture/data-lifecycle-plan.md) |
| Tähtilaskenta, UTC/paikallisaika, koordinaatit, magnitudit ja paikallinen katalogi | [architecture/sky-calculation.md](architecture/sky-calculation.md) |
| Paikallisen tähtikartan projektio, kohdevalinta, aika/paikka ja kartan IPC | [architecture/sky-map.md](architecture/sky-map.md) |
| AI:n sijoittelu, ohjelmakoodin työnkulku, agenttiroolit ja delegointi | [architecture/assistant-orchestration-plan.md](architecture/assistant-orchestration-plan.md) |
| Käyttöliittymätekniikka, sääpalveluvertailu ja riippuvuuskartta | [architecture/technology-and-ui-plan.md](architecture/technology-and-ui-plan.md) |
| Kevyt backend, ensimmäisen rungon vaiheistus ja rakennuksen tarkistukset | [architecture/initial-skeleton-plan.md](architecture/initial-skeleton-plan.md) |
| Mallirajapinta, asetusten mallinvaihto ja mallikansio, vertailukokoelma, moottorin turvatiedot, lisenssit ja Codexin stdio-MCP-yhteys | [architecture/local-model-plan.md](architecture/local-model-plan.md) |
| Asennus, rakentaminen ja paikalliset testikomennot Windowsissa | [development/local-development.md](development/local-development.md) |
| Rajatun stdio-MCP-kehitysyhteyden käyttö ja Codex-isännän erillinen käyttöönotto | [development/mcp.md](development/mcp.md) |
| Käyttöön otetut riippuvuudet ja lisenssikoonti | [legal/dependencies.md](legal/dependencies.md) |
| Kehitystyön pääkehittäjä ja kriittisten muutosten tarkastaja | [AGENTS.md](../AGENTS.md#kehitystyön-roolit-ja-katselmus) |
| Ensimmäisen oman työskentelyskillin luonnos: tehtävän aloitus ja valmistuminen | [ai/skills/task-start-finish/SKILL.md](ai/skills/task-start-finish/SKILL.md) |
| Yhteinen kehitystapa, GitHub-tehtävien ja ohjeiden työnjako, kymmenen aloituskohtaa ja rakennemallin nimitys | [ai/project-start-checklist.md](ai/project-start-checklist.md) |
| Ensimmäisen 4B/8B-kokeen lukitut versiot, syötteet, ajotapa ja tulosmuoto | [experiments/model-pilot.md](experiments/model-pilot.md) |
| 4B/8B-laatuvertailun menetelmä, mittarien rajat ja tulkinta | [experiments/model-comparison.md](experiments/model-comparison.md) |
| Toteutuneen 4B-moottorikokeen kokoonpano, tulokset ja avoimet toimitusehdot | [experiments/model-runtime-probe.md](experiments/model-runtime-probe.md) |
| Ensimmäinen rajattu mallikoe, paikalliset testiajot, lähteen vieressä olevat testit, keskitetty E2E ja raportointi | [ai/testing-rules.md](ai/testing-rules.md) |

product/-kansio kuvaa käyttäjätarpeen ja tavoitellun tuloksen.
architecture/-kansio kuvaa miten sovellus rakennetaan. ai/-kansio ohjaa
kehitystyötä ja sen tarkistamista. Uusi aihe saa oman kansion, kun sille
syntyy todellinen dokumentointitarve. Erillisiä modules/-, decisions/- tai
muita tyhjiä dokumenttipuita ei perusteta varmuuden vuoksi.

Jokaisella sopimuksella on yksi omistaja. Muissa tiedostoissa käytetään
linkkejä; nykytilaa tai työjonoa ei kopioida jokaiseen suunnitelmaan.
