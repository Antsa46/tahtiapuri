# Natiivibackendin ensimmäinen toiminnallinen koe

T09r, issue #10:n osatulos. Natiivin backendin pohja toimii rajatussa
Windows-kokeessa. Sovelluksen oletusbackend ei vielä vaihdu eikä issue
valmistu tämän näytön perusteella.

Omistajuuden, oikeuksien, TBIP/2:n ja palautuksen sopimus on
[natiivin backendin arkkitehtuurissa](../architecture/native-backend-runtime.md).
Tässä kuvataan tehty koe ja sen rajat.

## Kokoonpano

Koe käyttää tuotantokandidaatin suljettua ohjelmapakettia: virallinen
lukittu Node, varsinainen backend, domain/validation, backend-transport,
Astronomy Engine ja paikalliset katalogit. Paketin 40 tiedostoa ja manifesti
sidotaan brokeriin upotettuihin koko-/SHA-pinneihin. Testikoodeja tai
koko node_modules-puuta ei toimiteta työntekijälle.

Electronin backend-ohjain ja uusi NativeBackendPort käyttävät natiivibrokeria.
Graafista Electron-sovellusta, kielimallia, GPU:ta tai sää-APIa ei
käynnistetä. Aineisto on synteettistä ja erillään sovelluksen käyttäjätiedoista.
Pyydetty politiikka on LPAC + registryRead; LPAC-lippukyselyn null/87/0
säilyy epävarmana havaintona. Natiivin takaisin luetut Job-rajat ovat yksi
prosessi, yksi suoritin, BelowNormal ja prosessin 512 MiB:n commit-raja.
Verkkokieltoa ei tämän kokeen yhteydessä yritetty todistaa.

## Todennettu toiminta

Tuoreen datajuuren palautusalustus sekä kaksi peräkkäistä backend-istuntoa
läpäisivät. Ensimmäinen istunto palautti ready-viestin ja runtime-tilan,
luki tyhjän havaintopaikkatilan, tallensi ja aktivoi testipaikan revisioon 2
sekä palautti täydellisen 5 079 kohteen taivaan: 5 070 tähteä ja yhdeksän
aurinkokunnan kohdetta. Toinen istunto palautti saman revision, paikan ja
aktiivivalinnan levyltä.

Molemmat istunnot vastasivat hallittuun shutdowniin, ja workerin sekä
brokerin poistumiskoodi oli 0. Luotettu loppukuitti oli normal/clean:
Job tyhjä, dataoikeudet palautettu, profiili ja istuntokansio poistettu,
journal CLEAN. stderrComplete ja molemmat konsolittomuushavainnot olivat
true, eikä stderr-tulostetta tullut. Tunnettujen prosessitunnisteiden
poissaolo tarkistettiin lisäksi erikseen.

Riippumaton tarkastaja purki säilytetyt ulommat ja sisemmät TBIP/2-kehykset,
vertasi vastaukset raporttiin sekä tarkisti levyn observing-tarkistussumman,
CLEAN-journalin, tyhjän sessions-hakemiston ja rakennuksen lähde-/pakettipinnit.
Lähtevä pyyntövirta ei kuulu raakatallenteeseen: täsmällisen pyyntö–vastausparin
varmistaa myös katselmoitu ohjain ja portti. ACL-palautuksen ja profiilin
poiston näyttö on brokerin kuitti ja lähdepolku, ei erillinen Windows-auditointi.

## Kohdistetut tarkistukset ja korjaukset

- Kuljetus, stdio-backend ja ParentModelEngine: 49 testiä.
- NativeBackendPort, ohjain ja malliperuutuksen integraatio: 55 testiä.
- Desktopin runtime-resurssit: 14 testiä.
- Suljetun paketin kerääjä: 11 testiä.
- Erillinen natiivipolun koe: kuusi tapausta, mukana yli 260 merkin
  tiedostopolku sekä hardlink- ja hakemistojunction-hylkäykset.
- Backendin ja desktopin kohdistetut TypeScript-rakennukset sekä
  lopullisen natiivibrokerin käännös onnistuivat.

Luvut kuvaavat eri kohdistettuja ajoja; niitä ei esitetä yhtenä koko
sovelluksen testiajona. Aiemmat epäonnistuneet tulokset säilyvät paikallisessa
näytössä. Kokeet paljastivat pitkien Win32-polkujen käsittelyn puutteen,
puuttuvat scratch-profiilimuuttujat sekä työntekijän tarpeettoman yksityisten
esivanhempien metatietokyselyn. Korjaukset katselmoitiin ja kokeet uusittiin
uusilla rakennuksilla ja testijuurilla. Käyttöoikeuksia ei laajennettu
esivanhempiin.

## Avoin hyväksymisnäyttö

Yksittäisen istunnon pitkä/tyhjä toiminta ja vanhat kokonaiskiintiöt ylittävä
liikenne, omistajan/brokerin kaatumiset ja recover, käyttäjäaineiston
observing-migraatio sekä pakettiversion vaihtaminen tarvitsevat vielä näytön.
Myös muuttuneen ohjaimen graafiset MCP-regressiot ovat tämän osatuloksen
jälkeen uusittavaa tarkistusta.

Oikea CPU-malli, saman kokoonpanon verkkokielto, MCP:n natiivi eristys,
FMI-koetoiminto, GPU/ajotapavalinta ja lopullinen minimaalinen kokonaispaketti
säilyvät issue #10:n hyväksymisehdoissa. Monen istunnon yhteiskesto ei todista
yhden istunnon aikarajattomuutta. Raakadata, käyttäjä-/konetunnisteet ja
paikalliset polut säilyvät Gitin ulkopuolella.
