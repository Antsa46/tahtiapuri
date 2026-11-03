# Kehityksen GPT-mallien työnjako

Tämä on tehtäväkohtainen suositus 3.11.2026, ei tehty malliasetusten muutos
tai omassa projektissa mitattu paremmuusjärjestys.
Pääkehittäjä ja kriittisten muutosten erillinen tarkastaja on jo sovittu
[työohjeessa](../../AGENTS.md#kehitystyön-roolit-ja-katselmus).

## Ehdotettu työnjako

| Työ | Ensisijainen suositus | Päättely ja tarkastus |
| --- | --- | --- |
| Rajatun ominaisuuden toteutus, testit ja korjaukset | GPT-6.1 Sol | Tehtävään sopiva taso; vaativaan toteutukseen usein high, laajoihin riippuvuuksiin tarvittaessa xhigh. |
| Koko roadmap, suuret arkkitehtuuripäätökset ja vaikean ongelman selvitys | GPT-6 Astra | Rajattu kysymys, lähteet ja hyväksymisehdot; tavallista syvempi päättely tarpeen mukaan. |
| Merkittävä OS-eristys, natiivimoottorin raja tai paketoinnin riskikatselmus | GPT-6 Astra | Erillinen tarkastelukonteksti ja konkreettinen muutos sekä testinäyttö. |
| Tavallisen muutoksen katselmus | GPT-6.1 Sol | Sama malli voi hoitaa eri roolin; oma arvio lähteestä ja muutoksen vaikutuksesta. |
| Käyttöliittymän visuaalinen arviointi, kuvakaappaukset ja tekstin selkeys | GPT-6.1 Terra tarvittaessa | Selvä tavoite ja vertailukelpoinen tulos. Käyttö ei ole pakollinen vaihe joka tehtävään. |

6.1 Sol voi siis olla käytössä suurimman osan projektista. Astraa kannattaa
arvioida silloin, kun tehtävän epävarmuus, laajuus tai väärän ratkaisun hinta
kasvaa. Terralle on oma mahdollinen vahvuus visuaalisessa ja kirjoittavassa
työssä; sen paremmuutta tämän sovelluksen koodauksessa ei oleteta.
Jos Solilla tarkoitetaan aiempaa GPT-6 Solia, sille ei tarvita erillistä
roolia vain mallivalikoiman kasvattamiseksi.

Tavoite on laadukas, johdonmukainen työ. Mallia ei vaihdeta vain pienen
tokenisäästön vuoksi. Myös käyttäjän valitseman Astran pitäminen päämallina
on mahdollinen toimintatapa. Suositus valitaan tehtävän ja käyttäjän
toiveen perusteella, ei tämän taulukon mekaanisena kiertona.

## Käytännön käyttö

Pääistunnon mallin tai erillisen tarkastajan mallin vaihtamista ei väitetä
tehdyksi ilman toteutuneen valinnan vahvistusta. Tämä dokumentti ei luo
agenttikonfiguraatiota tai automaattista mallireititintä.
Käytettävissä olevat mallit ja päättelytasot tarkistetaan työistunnosta.

Issueen voidaan merkitä suositeltu toteuttaja, tarkastustarve ja erityinen
perustelu mallivalinnalle. Tarkastajalle annetaan rajattu tavoite, muutos,
omistavat ohjeet ja näyttö. Sama pitkä keskustelu ja koko docs-puu eivät
ole oletusarvoinen aineisto jokaiseen erilliseen arvioon.

Mallien vertailussa käytetään samoja lähtötietoja ja hyväksymisehtoja.
Arvioidaan myös korjaamiseen ja katselmointiin kuluva työ. Suurempi
päättelytaso ei yksin osoita parempaa tulosta.

Sovelluksen paikalliset 4B/8B-mallit, GGUF-painot ja ajonaikaiset malliroolit
ovat eri asia kuin nämä kehityksen GPT-valinnat. Niiden suunnitelman omistaa
[paikallisen mallin suunnitelma](../architecture/local-model-plan.md).

## Mallin ilmoittaminen ja issuekohtainen tokeniseuranta

Sovittu 3.11.2026: kerro käyttäjälle aina tehtävän alussa suositeltu GPT-malli.
Ilmoita uusi suositus myös, jos työ muuttuu olennaisesti vaativammaksi.
Merkitse issueen suositus ja todellinen käytetty malli erikseen;
käyttäjän ilmoitus ja ajon metatieto ovat eri lähteitä.
Vaihtoa ei väitetä tehdyksi ilman vahvistusta.

Kirjaa jokaisen käsiteltävän issuen valmistumisraporttiin käytetty malli,
mahdollinen tarkastaja sekä tokenikulutus omana kohtanaan.
Käytä issueen rajattua mitattua lukemaa, jos sellainen on saatavilla.
Merkitse lähde, looginen alku- ja loppuraja sekä snapshotin ulkopuolelle jäävä työ.
Tarkat istuntoaikaleimat ja tunnisteet säilyvät paikallisina; julkiseen issueen
kirjataan vain tehtävän koontiluvut [yksityisyyslinjan](../privacy/publication.md) mukaan.
Tämän keskustelun koko historian lukemaa tai tilin käyttörajojen muutosta
ei kirjata yhden issuen kulutukseksi.

Erittele lähteen sallimalla tarkkuudella input, cached input ja output.
Cached input on inputin osa; reasoning output on outputin osa.
Älä summaa näitä alaluokkia uudelleen kokonaistokenien päälle.
Pidä tarkastajan kulutus erillään, jos pääistunnon lukema ei sisällä sitä.
Puuttuva tieto merkitään ”ei saatavilla”, ei nollaksi.
Mahdollinen arvio nimetään arvioksi ja sille kerrotaan laskentatapa.
Tokenimäärää ei muunneta tilauskiintiöksi tai euroiksi ilman vastaavaa tietoa.

## Lähdepohja

Tarkistettu OpenAI Docsista 3.11.2026. Virallinen kuvaus painottaa Astran
vaativaa päättelyä, 6.1 Solin laajoja työtehtäviä ja Terran visuaalista
ymmärrystä, tietokonekäyttöä sekä kirjoittamista. Taulukon projektikohtainen
työnjako ja päättelysuositukset ovat meidän ehdotuksemme.

- [OpenAI Docs: Models](https://learn.chatgpt.com/docs/models)
- [OpenAI Docs: Model selection](https://developers.openai.com/api/docs/guides/model-selection)
