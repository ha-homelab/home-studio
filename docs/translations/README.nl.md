# Home Studio — Snel aan de slag

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=nl) · [Languages](README.md)

Teken je huis in de browser. Je hebt geen account nodig. Kies bovenaan in de editor je taal.

1. Voeg kamers, muren, deuren en ramen toe. De bibliotheek bevat 195 modellen. Kies een kleurenpalet en bij geschikte objecten een oppervlaktepatroon.
2. Exporteer JSON om een bewerkbare kopie te bewaren. Concepten blijven alleen in deze browser. Een taalwissel verandert je plattegrond niet.

Download en pak de volledige gereedschapsset uit. Installeer Python 3.10 of nieuwer. Voer in de map van de gereedschapsset het volgende uit:

[ZIP](https://github.com/ha-homelab/home-studio/archive/refs/heads/main.zip)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

De Engelse installatiehandleiding legt back-ups, Home Assistant OS, het configuratiepad en opnieuw opstarten uit. De browsereditor maakt zelf geen verbinding met Home Assistant en bedient geen apparaten.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=nl) · [README](../../README.md) · [i18n](../i18n.md)

Je plattegrond en apparaat-ID’s kunnen privé zijn. Gebruik een fictief huis voor openbare voorbeelden.

Dit is een vertaalde snelstartgids. De volledige documentatie en geïllustreerde handleiding zijn momenteel in het Engels. Verbeteringen aan vertalingen zijn welkom.

MIT · [LICENSE](../../LICENSE)
