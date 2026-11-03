# MCP-kehitysyhteyden käyttö

T05:n stdio-sovitin on `apps/mcp/`-sovelluksessa. Kolmen työkalun,
oikeuksien ja resurssirajojen sopimuksen omistaa
[mallisuunnitelma](../architecture/local-model-plan.md#kehitys--ja-diagnostiikkarajapinta-paikalliseen-malliin).

## Käynnistys

1. Valmistele ja rakenna projekti [kehitysohjeella](local-development.md).
2. Käynnistä Tähtiapuri ja kytke asetusten Kehitystyökaluista
   **Salli Codex/MCP-kehitysyhteys** päälle.
3. Käynnistä MCP-asiakkaan stdio-palvelimena projektin lukittu Windows-Node
   ja `scripts/launch-mcp.mjs`. Asiakas omistaa tämän prosessin.
4. Listaa työkalut. Lähetä `model_probe`-työkalulle vain kyseiseen kokeeseen
   tarkoitettu `prompt` ja `backend` (`cpu` tai `cuda`).
5. Lue palautetun työn tila ja vastaus `model_status({ jobId })`-kutsulla,
   enintään kahdesti sekunnissa. Peru tarvittaessa `cancel_probe({ jobId })`.

Pois kytkeminen peruu MCP:n kokeet ja katkaisee yhteyden. Käyttöliittymän
työt säilyvät. Uusi kytkentä tai sovelluskäynnistys vaatii myös
MCP-palvelimen uudelleenkäynnistyksen: vanha sovitin ei liity automaattisesti
uudella oikeudella. Palvelin ei käynnistä Tähtiapuria tai lataa malleja.
Yhteyskuvausta tai sen salaisuutta ei kopioida asetuksiin, chattiin tai GitHubiin.

## Codex-isännän erillinen käyttöönotto

OpenAI dokumentoi paikallisen stdio-palvelimen ja projektikohtaisen
`.codex/config.toml`-määrityksen luotetulle projektille.
Tämä yleinen esimerkki täytetään paikallisen Windows-isännän poluilla:

```toml
[mcp_servers.tahtiapuri]
command = '<PROJECT>/.local/toolchain/node-v24.22.2-win-x64/node.exe'
args = ['<PROJECT>/scripts/launch-mcp.mjs']
cwd = '<PROJECT>'
enabled = false
enabled_tools = ["model_status", "model_probe", "cancel_probe"]
startup_timeout_sec = 10
tool_timeout_sec = 10

[mcp_servers.tahtiapuri.env]
NODE_OPTIONS = ""
ELECTRON_RUN_AS_NODE = ""
```

Isäntäasetusta ei lisätä tai sallita sovelluksen kytkimestä.
Ota se erikseen käyttöön ja käynnistä palvelin uudelleen vasta sovelluksen
kehitysyhteyden avaamisen jälkeen. Käytä isännässä tunnettua ohjelmaa,
työhakemistoa ja tyhjennettyjä runtime-injektion ympäristöarvoja.
Käynnistin rajaa sovittimen ympäristöstä muut muuttujat pois.
Konekohtainen määritys kuuluu paikallisiin muistiinpanoihin.

[OpenAI Docs: MCP](https://learn.chatgpt.com/docs/extend/mcp) omistaa isännän
asetusten tarkan käytön. Oikea SDK-asiakas testataan projektin E2E:ssä;
se ei itsessään todista tämän chatin Codex-isännän asetusta tai WSL:n
läpi toimivaa käynnistystä. Yleisiä Codex-asetuksia ei muuteta T05:n testeissä.

## Testit ja tulosteet

`test:e2e` käyttää oikeaa MCP SDK -stdio-asiakasta, oikeaa Electronia,
erillistä testiprofiilia ja synteettistä mallityöntekijää.
`test:model` sisältää lisäksi 4B:n UI → MCP → UI -kontekstikokeen ja
peruutuksen jälkeisen erottelun oikealla natiivimoottorilla.

Yksikkö- ja integraatiotestit kattavat työn omistajuuden, vanhat oikeudet,
kytkimen sulkuracen, rajatun siirtymäjonon, yhdistetyt ja osittaiset kehykset,
hitaan lukijan sekä Windowsin descriptor-hakemiston DACL:n.
Raakatulokset ja ensimmäisten virheiden näyttö säilyvät `.artifacts/tests/`-puussa.

Tämä kehitysajo ei todenna sovelluksen, mallin tai named pipen OS-verkkokieltoa.
T09:n eristys ja paketoidun sovelluksen näyttö ovat erillisiä työpaketteja.
