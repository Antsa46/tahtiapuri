# Paikallinen tähtiaineisto

stars.json on **HYG Database 4.1** -aineiston johdannainen.
Tekijä-/lähdemerkintä: **Astronexus ja HYG Database -tekijät**.
HYG yhdistää Hipparcos-, Yale Bright Star- ja Gliese-katalogeja.

Manifesti lukitsee lähde-URL:n, revision c7f7f883fe678cc7680169a50ccd7dcc49b060ce
sekä alkuperäisen ja johdetun SHA-256:n.
[HYG-kenttien kuvaus](https://github.com/astronexus/HYG-Database/blob/c7f7f883fe678cc7680169a50ccd7dcc49b060ce/hyg/README.md)
kertoo J2000.0-epochin/equinoxin ja Cartesian-yksiköt.

Muutokset alkuperäiseen:

- Aurinko (id 0) poistettu. Valittu katalogin V-magnitudi ≤6,0: 5 070 tähteä.
- Säilytetty vain JSONin columns-kentässä nimetyt kentät.
- Nimeksi otettu proper, Bayer/Flamsteed, HIP- tai HYG-tunniste.
- Paikat (parsec) ja nopeudet (parsec/vuosi) säilytetty ilman lisäpyöristystä.
- Rivit järjestetty HYG-tunnisteen mukaan.

Tämän hakemiston HYG-johdannainen, manifesti ja aineistokuvaus ovat
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) -lisensoituja.
Alkuperäinen merkintä on [HYG-LICENSE.md](HYG-LICENSE.md).
Säilytä lähde, muutosmerkinnät ja sama lisenssi aineiston edelleenjaossa.
Tämä ei valitse sovelluksen oman lähdekoodin lisenssiä.

## Muodostaminen uudelleen

Alkuperäinen CSV ei kuulu Gitiin. Hanki manifestin täsmällisestä URL:sta
.local/catalog-sources/hyg-v41.csv ja aja kehityksessä:

```text
<project-node> scripts/catalogs/build-catalog.mjs
```

Offline-skripti tarkistaa alkuperäisen CSV:n SHA-256:n eikä käytä verkkoa.
Build tai sovellusajo ei suorita sitä. Aineiston vaihto vaatii myös
sovittimen hyväksyntätarkisteen päivityksen ja katselmuksen.
[Laskentasopimus](../../docs/architecture/sky-calculation.md) omistaa ajan ja tarkkuusrajat.
