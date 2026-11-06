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
- `mcp-input-gate.ts` tarkistaa viestit ja varaa keskeneräisille pyynnöille
  paikat ennen SDK:n tuloviestijonoa.
- `bounded-mcp-transport.ts` yhdistää sisäänoton rajauksen vastausten
  tavurajoihin ja määräaikoihin vain tässä ehdokkaassa.

Nykyinen startMcp(descriptionFile) ja sen tavallinen SDK-stdio-käynnistys
säilyvät. Sovelluksen sulkeuduttua nykyinen ulkoinen adapteri voi edelleen
palauttaa ENGINE_UNAVAILABLE; tätä ei vaihdeta uuden ehdokkaan
sulkusopimukseksi samoissa tuotantotesteissä. Asetusten kehityskytkimen
nykyiset oikeusrajat säilyvät.

## Omistajuus ja sulku

Injektoitu kehitys-Duplex kuuluu aina istunnolle. SDK voi vaihtaa
protokollan tunnistusvaiheessa palvelininstanssia; tällaisen instanssin
sulku ei sulje yhteistä kehityskanavaa. `createDevelopmentServer` omistaa
asiakkaan oletusarvoisesti, mutta stream-kooste käyttää `ownsClient: false`
-asetusta ja hoitaa kanavan lopullisen sulun itse.

MCP-streamien omistajuus
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
| MCP-tulokehys ja SDK-tulopuskuri | 16 KiB; kehysraja sisältää rivinvaihdon |
| MCP:n keskeneräiset pyynnöt | enintään kahdeksan, yhteensä enintään 128 KiB koodattuja tulokehyksiä |
| MCP-pyynnön elinaika | enintään 10 sekuntia vastaanotosta vastauksen kirjoituksen valmistumiseen |
| MCP-pyynnön tunniste | safe integer tai enintään 128 tavun merkkijono; tyyppi erottaa tunnisteet |
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

SDK:n `serveStdio`-jonon edessä on nyt yksityinen Transform-kanava.
Se kokoaa yhden kehyksen kiinteään puskuriin, tarkistaa tiukan UTF-8:n ja
JSON-RPC-pyyntökuoren ja päästää läpi vain rajatun määrän pyyntöjä.
Tyhjät rivit, eräpyynnöt, virheellinen koodaus, BOM, tuntemattomat kuorikentät
ja muut kuin objektimuotoiset `params`-arvot hylätään. Tämä rajaus on
kehitysehdokkaan sopimus, ei yleiskäyttöisen MCP-palvelimen toteutus.

Sama tunniste ei saa olla kahdessa keskeneräisessä pyynnössä. Varaus
vapautuu vasta vastauksen kirjoituscallbackin ja tarvittaessa drainin
jälkeen; pelkkä työkalun valmistuminen ei riitä. Tunnistetta saa käyttää
uudelleen valmiin vastauksen jälkeen. Myöhäinen callback ei vapauta
uuden pyynnön varausta. Sulku pysäyttää sisäänoton välittömästi, irrottaa
alkuperäisen tulon yksityisestä kanavasta ja poistaa määräajat.

Yksi `notifications/initialized` sallitaan. Muu ilmoitus, myös
`notifications/cancelled`, sulkee ehdokkaan yhteyden. SDK voi jättää
protokollatasolla perutun pyynnön vastauksen lähettämättä; varauspaikkaa ei
vapauteta arvaamalla. Mallityön peruuttamiseen käytetään tavallista
`cancel_probe`-työkalua, jonka jälkeen samaa yhteyttä voi käyttää edelleen.
Palvelimen aloittamia asiakaspyyntöjä, tilausten avaamista tai muita
kaksisuuntaisia toimintoja ei oteta tällä käyttöön.

Nämä rajat koskevat tämän koosteen viestejä ja jonoja. Ne eivät ole koko
Node-prosessin muistimittaus tai käyttöjärjestelmätason suojaus. Tulevan
natiivibrokerin omat kanavat, rajat ja resurssipaketti on vielä toteutettava
ja testattava erikseen.

## Sisäänoton ja protokollavaihdon jatkokoe

Lukitun SDK:n rajattu synteettinen koe vastaanotti 257 pyyntöä palvelimen
tehtaan odottaessa vapautusta. Tulostreamien puskurit olivat tyhjät eikä
vastauksia ollut vielä kirjoitettu. Vapauttamisen jälkeen kaikki pyynnöt
saivat vastauksen. Koe osoittaa, ettei SDK:n raakapuskurin raja yksin rajoita
jo parsittujen pyyntöjen jonoa; sillä ei mitattu keon kokoa.

Oikealla SDK:lla tehty regressio toisti myös ennenaikaisen kehityskanavan
sulun siirryttäessä modernista tunnistuksesta vanhempaan alustukseen.
Istunnon omistajuuskorjaus poisti virheen; moderni ja vanhempi yhteys sekä
tavallisen entrypointin omistajuus säilyivät toimivina.

Sisäänottorajauksen kohdennettu sarja läpäisi 83 testiä ja MCP-moduulin
TypeScript-käännös onnistui. Sarja sisältää oikean SDK:n pidätetyn
avaustehtaan: enintään kahdeksan pyyntöä pääsee käsittelyyn, yhdeksäs
sulkee yhteyden, samoin määräaika tai erillinen sulku. Myöhään valmistuva
palvelininstanssi suljetaan lähettämättä vastauksia. Mukana ovat lisäksi
protokollavaihto, tunnisteiden uudelleenkäyttö, tavurajat, virheelliset
kehykset, vastapaine, peruutukset ja uudelleen sisään tuleva sulkukutsu.
Tämä on paikallinen stream-tason näyttö; käyttöjärjestelmätason eristystä
tai uuden koosteen desktop-käyttöönottoa ei ole tällä todennettu.

## Aiemman koostamisvaiheen näyttö

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
