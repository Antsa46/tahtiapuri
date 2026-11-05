# MCP-palvelimen injektoitavat viestiyhteydet

Tämä osavaihe valmistelee oikean MCP-palvelinkoodin ajamista myöhemmin
rajatussa Nodessa. Se ei toteuta natiivibrokeria, multiplex-kuljetusta,
mainin kertakäyttövaltuutta tai MCP:n käyttöjärjestelmätason eristystä.
Jatkorajauksen omistaa [eristyspolku](../architecture/backend-mcp-isolation.md).

## Koodin vastuut

- `server-core.ts` rekisteröi nykyiset kolme työkalua: model_status,
  model_probe ja cancel_probe. Skeemat, peruutus, ohje ja tuloksen kaksi
  JSON-esitystä säilyvät.
- `connected-development-client.ts` käsittelee jo autentikoidun Duplexin.
  Se ei lue yhteyskuvausta tai avaa socketia. Istunto omistaa tämän kanavan;
  sulku vapauttaa odottavat pyynnöt ja estää uudet.
- `development-client.ts` omistaa tavallisen ajotavan yhteyskuvauksen,
  socketin ja token-autentikoinnin. Samassa tavuerässä saapuvat
  autentikoinnin jälkeiset täydet ja osittaiset vastaukset siirretään
  käsittelijälle ennen uusien pyyntöjen hyväksymistä.
- `stream-server.ts` tarjoaa erillisen startMcpStreams-koosteen. Kutsuja
  antaa MCP:n tulo- ja lähtöstreamit sekä valmiin kehityskanavan. Polkua,
  tokenia, verkkokohdetta tai tiedostotyökalua ei anneta tälle koostajalle.
- `bounded-mcp-transport.ts` rajaa ehdokkaan MCP-vastaukset ja niiden
  odotuksen. Se korvaa SDK:n send-metodin vain tässä ehdokkaassa.

Nykyinen startMcp(descriptionFile) ja sen tavallinen SDK-stdio-käynnistys
säilyvät. Sovelluksen sulkeuduttua nykyinen ulkoinen adapteri voi edelleen
palauttaa ENGINE_UNAVAILABLE; tätä ei vaihdeta uuden ehdokkaan
sulkusopimukseksi samoissa tuotantotesteissä. Asetusten kehityskytkimen
nykyiset oikeusrajat säilyvät.

## Omistajuus ja sulku

Injektoitu kehitys-Duplex kuuluu aina istunnolle. MCP-streamien omistajuus
valitaan eksplisiittisesti:

- server: koostaja sulkee ja tuhoaa omat MCP-streaminsa. Tulokanavan
  myöhäisille luku- ja destroy-virheille jää käsittelijä sen eliniäksi.
- caller: SDK irrottaa käsittelijänsä ja pysäyttää lukemisen, mutta koostaja
  ei tuhoa kutsujan MCP-streameja. Niiden jatkosulku ja myöhäisten virheiden
  käsittely kuuluvat kutsujalle.

EOF, kehityskanavan sulku, tulon/lähdön virhe ja ulostulorajan ylitys
sulkevat ehdokkaan peruuttamattomasti. Sulku tyhjentää pending-pyynnöt,
jonot, määräajat ja omat drain-käsittelijät. SDK:n close ei yksin tuhoa
injektoituja streameja eikä vapauta sen alkuperäisen sendin mahdollista
drain-odotusta. Ehdokas omistaa siksi kirjoituslupauksensa itse.

## Kokeen rajat

| Raja | Ehdokkaan politiikka |
| --- | --- |
| Kehityspyyntö | enintään 16 KiB koodattuna, enintään neljä odottavaa |
| Kehitysvastaus | 64 KiB kehysraja, nykyisen parserin rajattu erä |
| Kehityskanavan jono | enintään 64 KiB; ei uutta kirjoitusta vastapaineen aikana |
| Kehityspyynnön ja drainin määräaika | 5 sekuntia |
| MCP:n SDK-tulopuskuri | 16 KiB |
| MCP-vastauksen koodattu rivi | enintään 256 KiB |
| MCP:n varatut lähtötavut | enintään 512 KiB; myös writablen jo puskuroimat tavut huomioidaan |
| MCP-lähtöjonon lähetykset | enintään 16 |
| MCP-lähetyksen kokonaisodotus hyväksynnästä | 2 sekuntia |
| MCP-tilaukset | nolla |

Nämä ovat ehdokkaan ohjelmallisia rajoja, eivät mitattuja kapasiteetti- tai
suorituskykytuloksia. JSONin lainaukset ja tuloksen kaksinkertainen esitys
huomioidaan koodatuissa lähtötavuissa. Kirjoitus valmistuu vasta callbackin
ja tarvittavan drainin jälkeen. Aikaraja tai ylikoko hylkää kaikki
keskeneräiset lähetykset ja sulkee ehdokkaan.

**Avoin raja:** SDK:n serveStdio jonottaa jo parsittuja tuloviestejä ilman
kokonaisjonon rajaa. Sen 16 KiB:n puskuriraja ei ole koko istunnon
muistiraja. Myöhempi mux/broker ja pitkäikäinen MCP tarvitsevat oman
sisäänoton sekä muistinkäytön hyväksynnän ennen OS-eristetyn kokonaisuuden
käyttöönottoa. Tämä osavaihe ei väitä sulkevansa sitä rajaa.

## Todennettu näyttö

Kohdennettu MCP-moduulin TypeScript-käännös ja 49/49 yksikkötestiä läpäisivät.
Testeissä käytetään oikeaa SDK:ta muististreameilla ja synteettistä
aineistoa. Mukana ovat kehystys, autentikoinnin jälkeinen aineisto,
pyyntörajat, vastapaine, abortit, työkalut, sulku ja myöhäinen lukuvirhe.

Riippumaton Astra-katselmus löysi omistetun tulostreamin myöhäisen
virheen käsittelystä puutteen. Korjaus tarkistettiin uudelleen, ja oikean
Readablen viivästetty destroy-virhe lisättiin regressiotestiksi.

Kuusi olemassa olevaa työpöydän MCP-regressiotestiä läpäisivät synteettisellä
mallivastaajalla: oletuksena suljettu yhteys, työkalurajaus, UI/MCP:n
työomistukset, kytkimen sulku ja vanha valtuus, stdio-katkos sekä
sovelluksen sulku ja uudelleenkäynnistys. Tämä on tavallisen nykyisen
ajotavan yhteensopivuusnäyttö, ei LPAC-ajo.

Oikeaa mallia tai ulkoista verkkopalvelua ei käytetty. Natiivinen
kahden kanavan silta, suljettu resurssipaketti, mainin prosessitunnistus
ja valtuus, OS-tiedosto-/verkkorajat sekä koko sovelluspaketti jäävät
avoimiksi. Ajantasainen osatulos ja mitatut kehitystokenit kirjataan
issueen #10; raakadata pysyy paikallisena.
