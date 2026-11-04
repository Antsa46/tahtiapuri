# Rajattu keskustelukonteksti ja CPU-tekstintuotto

T09f / #29 jatkaa [todennettua 4B-latausta](model-isolation-probe.md) parentin
#10 alla. Tila: kaikki kuusi rajattua CPU-konteksti-/generointikoetta läpäisivät 4.11.2026.
Sovelluksen runtimea tai käyttöoikeuksia ei vaihdeta tämän koepaketin perusteella.

## Kiinteä koe

Sama hyväksytty Qwen3-4B Q4_K_M, korjattu erillinen Node 24.22.2 ja
node-llama-cpp 3.22.2:n CPU-binääri. Oma `run-inference-candidate`-verbi
hyväksyy vain t09f-profiilin, control/lpac-tilat sekä generate/cancel/context-hold-
elinkaaret. T09e:n latausverbin hyväksyttyjä elinkaaria ei laajenneta.

Konteksti on 512 tokenia, yksi sekvenssi, batch 32, yksi säie ja
flashAttention=false. Asetukset ja luotu tilakoko luetaan takaisin SDK:sta.
Keskustelu käyttää tarkistettua mallin Jinja-chat-templatea reasoning=false-
asetuksella ja kiinteää synteettistä suomenkielistä system/user-syötettä.
Vastaus on enintään 16 tokenia, temperature=0 ja seed=42. Työkaluja,
responsePrefixiä, käyttäjädataa tai ulkoisia syötteitä ei anneta.

Aikaisemman latauskokeen koekopio, hostin pidetty READ/SHARE_READ-kahva,
koko painon tarkiste, seitsemän tiedosto-operaatiota, tarkka token-/Job-raja
sekä omien prosessien siivous säilyvät. Valmisteluajurin BelowNormal ja
käyttö yhdellä suorittimella varmennetaan ennen painojen käsittelyä.
Workerin Job sallii yhden prosessin ja enintään 6 GiB commit-muistia;
raja ei ole lämpötilan tai fyysisen muistin takuu. GPU ja verkko jäävät pois.

Kontekstin luontisignaali on 30 sekuntia ja generoinnin aikaraja 60 sekuntia.
Hostin kokonaisaikaraja on 180 sekuntia. Aikaraja ei ole onnistunut
peruutuskoe. Epäonnistuminen pysäyttää matriisin ja alkuperäinen havainto säilytetään.

## Kolme tapausta kummassakin profiilissa

| Tapaus | Hyväksymisnäyttö |
| --- | --- |
| Normaali | Oikea input/output-mittarin muutos, 1–16 output-tokenia, ei-tyhjä rajattu päävastaus sekä session/sequence/context/model/llama-vapautus getterien perusteella. |
| Peruutus | Ensimmäinen ei-tyhjä onToken-erä käynnistää oman abortin. StopReason=abort, oma syy ja lippu sekä positiivinen tokenimittarin muutos; timeout ei laukea. Kaikki oliot vapautetaan pyynnön ratkettua. |
| Omistajan sulku | Normaali rajattu vastaus valmistuu, session/sequence/context/model todetaan eläviksi ja worker jää hold-tilaan. Vain oma nimetty omistaja suljetaan; kaikki omat prosessit ja konsoli poistuvat ennen korjaavaa siivousta. |

OnToken tuottaa token-eriä. Koe ei oleta yhden tokenin erää. Callback
ainoastaan laskee ja pyytää peruutusta; hyväksymistarkistukset tehdään sen
ulkopuolella, koska SDK voi käsitellä callbackin poikkeuksen itse.
Peruutus ei edellytä valmista näkyvää tekstikatkelmaa ensimmäisestä erästä.
Generointipyynnön valmistumista odotetaan SDK:n AbortSignalin kautta.
Pelkkä kilpailevan timeout-Promisen valmistuminen ei osoittaisi tätä.
Session suljetaan ilman automaattista sekvenssin sulkua, minkä jälkeen
sekvenssin async-dispose odotetaan ennen getterien tarkistusta ja kontekstin sulkua.

Mallin vastausta ei tulkita JSON-ohjausviesteiksi tai työkaluiksi. Tulokseen
kirjataan vain tavumäärä, SHA-256, tokeniluvut ja suljetut tilat. Oman
workerin koerivit kehystetään erikseen, joten se ei voi tehdä hostin
identiteetti-, pin- tai resurssikuitteja. Latauksen yhteiset validoinnit
käytetään sellaisinaan; T09f:n lisävaiheet validoidaan niiden lisäksi.

## Ajaminen

Käännä ensin tarkistettu natiivihost rajatulla kuormalla. Tarkista sekä
uuden verbin hylkäystapaukset että T09e:n vanha rajajoukko ilman mallia.
Tämän jälkeen erillisessä PowerShell-prosessissa:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\e2e\isolation\run-model-limited.ps1 -Inference -CheckOnly
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\e2e\isolation\run-model-limited.ps1 -Inference
```

Ajuri etenee kontrollin kolmesta tapauksesta LPAC:n kolmeen tapaukseen.
Vain yksi mallikopio ja prosessi on käytössä kerrallaan. Raakatulokset
säilyvät ohitetussa `.artifacts/tests/isolation/inference-runs/`-puussa;
julkinen tulos, tarkastajan arvio ja tokenit kirjataan issueen #29.

## Näyttörajat

Tämä testaa pienen kontekstin ja lyhyen vastauksen ajonaikaista toimintaa.
Se ei ole tähtitieteen laatuarvio, pitkän keskustelun tai rinnakkaisten
kontekstien koe eikä kesken natiivisen decode-kutsun pakkokatkaisun näyttö.
GPU, verkko/FMI, MCP ja koko Electron-minipaketti pysyvät parentin #10 portteina.
LPAC-tokenlipun suoran kyselyn aiempi null/87-raja sekä registryReadin,
jaetun koekonsolin ja oman Node-haaran tuotantosoveltuvuus säilyvät avoimina.

## Mitattu tulos

| Tapaus | Kontrolli | LPAC + registryRead |
| --- | --- | --- |
| Normaali vastaus ja hallittu vapautus | Läpäisi, 16 output-tokenia | Läpäisi, 16 output-tokenia |
| Oma peruutus ensimmäisestä token-erästä | Läpäisi, 1 output-token | Läpäisi, 1 output-token |
| Valmis vastaus ja elävän kontekstin omistajan sulku | Läpäisi, 16 output-tokenia | Läpäisi, 16 output-tokenia |

Jokainen tapaus käytti samaa synteettistä syötettä, jonka SDK-mittari kirjasi
44 input-tokeniksi. Normaalit ja omistajan sulkua edeltävät vastaukset
päättyivät maxTokens-rajalle; peruutukset omaan abortiin ilman timeoutia.
Varsinaisen vastauksen tavumäärä ja tarkiste kirjattiin, eikä mallitekstiä
käytetty ohjausviestinä. Nämä paikallismallin tokenit ovat erillisiä
kehityksessä käytettyjen GPT-mallien issuekohtaisesta tokeniseurannasta.

Kontekstin 512 tokenia, yksi sekvenssi, batch 32, yksi säie ja
flashAttention=false varmennettiin takaisinluvuista. SDK:n stateSize
kirjattiin ennen generointia; se ei ole KV-välimuistin tai prosessin
fyysisen muistin huippumittaus. Session, sekvenssin, kontekstin, mallin ja
moottorin odotettu vapautus toimi normaali- ja peruutustapauksissa.
Omistajan sulku tehtiin vasta valmistuneen vastauksen ja elossa olevien
keskusteluolioiden toteamisen jälkeen.

Kaikissa kuudessa tapauksessa omat prosessit ja konsolit poistuivat ennen
korjaavaa siivousta. Kaikki profiilit, koepuut ja yhteinen template poistuivat
ilman prosessien hätäsiivousta. Alkuperäisen painon tarkiste, koko,
tiedostoidentiteetti ja muokkausaika säilyivät. Kontrollin seitsemän
synteettistä tiedosto-operaatiota onnistuivat; LPAC:n paketin luku ja scratch-
kirjoitus onnistuivat, viisi muuta estyi. Pin-kahvan write/delete-estot
säilyivät erillisenä tiedoston jakamisrajan näyttönä.

Natiivihostin käännös, uuden verbin 25 ja vanhan latausverbin 18 kielteistä
käynnistyskoetta sekä 638 kevyttä yksikkö-/rajatestiä läpäisivät.
Kuormarajattu CheckOnly toimi molemmissa ajotiloissa; rajoittamaton ja
virheelliset ajurikutsut hylättiin ennen painovalmistelua.
Lähde-, binääri- ja raakatulostarkisteet on sidottu paikalliseen auditointiin.
Riippumaton katselmus ja julkinen tokeniraportti kuuluvat issueen #29.

Kontrollin omistajan sulkukokeessa koepuun Node-tiedoston ensimmäinen poisto
palautti EPERM-virheen ja toinen onnistui. Molemmat yritykset säilyvät
raakadatassa. Prosessit olivat jo poistuneet; poiston eston syytä ei yksilöity.
