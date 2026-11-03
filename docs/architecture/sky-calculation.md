# Paikallinen tähtilaskenta

T06 toteuttaa backendin sky-moduulin ja puhtaan domain-sopimuksen.
`createSky(catalogDirectory)` kokoaa sovittimet ja palauttaa SkyServicen.
Katalogihakemisto on luotetun koostamiskohdan asetus; sitä ei anneta
rendereristä, mallista tai MCP:stä. UI-/IPC-kytkentä kuuluu seuraavaan työpakettiin.

## Vastuut ja tulos

Domain omistaa havaintoajan, paikan, yksiköt ja geometrisen horisontin.
Application käyttää omia laskenta- ja katalogiporttejaan. Sovittimet
eristävät Astronomy Engine 2.1.19:n ja tiedostoluvun omien tyyppien taakse.

Snapshot sisältää Auringon, Kuun, seitsemän planeettaa (ei Maata) ja
HYG 4.1:n 5 070 tähteä. Jokaisella on tunniste, havaintoaika atUtc,
lähdetunniste, RA/Dec, korkeus, atsimuutti, ilmansuunta ja lähteistetty magnitudi.
Lähdetaulukko sisältää version, koordinaatiston ja käytetyt korjaukset.
Sama eksplisiittinen syöte tuottaa saman tuloksen; nykyhetkeä tai käyttäjän
sijaintia ei arvata. Pluto, pienkappaleet ja nousu-/laskuajat jäävät myöhemmiksi.

## Aika ja paikka

Laskenta ottaa eksplisiittisen UTC-ajan ...Z-muodossa sekä IANA-vyöhykkeen
ajan esittämistä varten. Tuettu UTC-väli on 2000–2100.
Virheellinen kalenteripäivä, puuttuva offset, karkaussekunti, virheellinen
vyöhyke ja ei-numeerinen paikka torjutaan. Leveysaste on −90…90°,
itäpositiivinen pituusaste −180…180° ja korkeus −500…10 000 m keskimerenpinnasta.

`resolveLocalTime` vaatii paikallisajan lisäksi eksplisiittisen UTC-offsetin.
Syksyn toistuva tunti hyväksyy kumpikin oikean offsetin; kevään puuttuva tunti
tai väärä offset hylätään. Paikallinen vuosi voi UTC-välin reunalla olla
1999 tai 2101, kun lopullinen UTC-hetki on tuettu.
Vyöhyke muuttaa esitystä, ei saman UTC-hetken taivaskoordinaatteja.
Intl/IANA ratkaisee siviiliajan. Tämä ei ole tarkka UT1/EOP- tai
karkaussekuntirajapinta.

## Koordinaatit ja geometria

RA on tuntia [0,24), Dec asteita [−90,90]. Kehys on havaintohetken
todellinen ekvaattori. Aurinkokunnalle `Equator(..., true, true)` korjaa
topocentrisen parallaksin, valon kulkuajan, aberration, prekession ja nutaation.
Horizon saa saman EQD-tuloksen, ilman ilmakehän refraktiota.
Atsimuutin 0° on pohjoinen, 90° itä; ilmansuunta on kahdeksan sektorin arvo.
Tarkassa zeniitissä/nadiirissa määrittelemätön atsimuutti/ilmansuunta on null.

Horisontti käyttää kohteen keskipistettä ja kertoo vain above/on/below.
Se ei tarkoita käytännön näkyvyyttä, nousuhetkeä tai esteettömyyttä.

Tähdille HYG:n J2000 Cartesian-paikkaa kuljetetaan vakionopeudella;
aikaero on TT:n Julian vuosia. Sen jälkeen tehdään EQJ→EQD prekessio/nutaatio.
Tähtiparallaksia, vuotuista aberraatiota ja kaksoistähtien rataliikettä ei lisätä.
Katalogin puuttuvan parallaksin etäisyysmerkintää ei julkaista etäisyysarviona.
Tämä on paljain silmin havainnoinnin pohja, ei tarkka astrometriapalvelu.

## Magnitudit ja Kuu

Aurinkokunnan magnitudi on Illumination-mallin geosentrinen, laskennallinen
ja ilman ilmakehän himmennystä. Saturnus sisältää renkaiden kallistuman.
Tähtien V-magnitudi on katalogiarvo; mukana on muuttuvia tähtiä, joten
se ei ole tämän illan kirkkausennuste. Puuttuva arvo on null, ei nolla.
Numeron kaikkia desimaaleja ei pidä esittää havaintotarkkuutena.

Kuun tiedoilla on oma lähde ja havaintoaika:

- phaseLongitudeDeg: ekliptinen pituusero [0,360); uusi Kuu noin 0°, täysi noin 180°.
- phaseAngleDeg: fysikaalinen Aurinko–Kuu–Maa-kulma [0,180]; täysi noin 0°, uusi noin 180°.
- illuminatedFraction: valaistu osuus [0,1].

## Katalogi ja näyttö

Lukija käyttää vain kiinteitä manifest.json/stars.json-nimiä luotetusta
resurssihakemistosta. Tiedostotyypit, kokorajat, lähderevisio, alkuperäisen
CSV:n SHA-256 ja sovittimeen sekä manifestiin lukittu johdettu tarkiste
varmennetaan. Tunnisteet, rivimäärä, yksiköt ja arvorajat validoidaan.
Nopeusraja on suhteessa etäisyyteen; puuttuvan parallaksin merkinnästä
ei päätellä fyysistä nopeutta. Virhe on CATALOG_INVALID ilman paikallista polkua.
Korjauslatausta tai verkkohakua ei käynnistetä.

[Aineiston kuvaus](../../resources/catalogs/README.md) omistaa lisenssin,
lähteen, muutokset ja offline-muunnoksen.
[Riippumattomat fixturet](../../tests/fixtures/sky/README.md) sisältävät
48 JPL-vertailua ja ERFA:n koordinaattivertailun. Paikkatoleranssi 0,04°
ja magnituditoleranssi 0,5 koskevat näitä kokeita, eivät kaikkien kohteiden
tai vuosien takuuta. Saturnuksen magnitudia ei verrata Horizonsiin eri
rengas-/kiekkokirkkausmallin vuoksi; paikkakoordinaatit verrataan.

JPL kattaa horisontin molemmat puolet, Suomen DST-vaihdot ja 70°N:n kesän/talven.
ERFA tarkistaa synteettisen tähtisuunnan, horisonttimuunnoksen ja omanliikkeen
erillisellä matriisilla. IANA tzdb-2024a määrittää siviiliajan testiodotukset.
Tavalliset testit eivät hae aineistoa verkosta.
