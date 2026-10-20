# Home Studio — Snel aan de slag

[Home Studio — Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=nl#native-studio) · [Languages](README.md)

## Begin in Home Assistant

Gebruik voor een nieuw huis Home Studio binnen Home Assistant. Een aparte Python-installatie, YAML en een toegangstoken zijn niet nodig.

Lees voor een bestaande gegenereerde of aangepaste component eerst **Existing generated homes** in de uitgebreide handleiding: er is geen automatische omzetting.

1. Gebruik Home Assistant 2026.10 of nieuwer en maak een back-up.
2. Voeg in HACS `https://github.com/ha-homelab/home-studio` toe als aangepaste repository met de categorie **Integration**. Installeer de stabiele versie van Home Studio met **home_floorplan.zip** en herstart Home Assistant.
3. Open **Settings → Devices & services → Add integration → Home Studio**.
4. Open als beheerder **Home Studio** in de zijbalk. Teken een kamer en koppel de objecten aan echte HA-apparaten.
5. Klik op **Save draft** en daarna op **Publish family view**. Open **3D Home** en controleer de koppelingen met **Dry run** voordat je apparaten bedient.

[Home Assistant guide — English](../home-assistant-editor.md) · [Install — English](https://ha-homelab.github.io/home-studio/install.html#native-studio)

## Optioneel: tekenen terwijl je HA instelt

Je kunt de aparte browsereditor gebruiken terwijl je HA voorbereidt. Deze heeft geen liveverbinding met HA. Exporteer JSON en open dit later met **Open JSON** in Home Studio binnen HA. Controleer de apparaten, sla het ontwerp op en publiceer het.

[Browser editor](https://ha-homelab.github.io/home-studio/planner/?lang=nl)

Teken je huis in de browser. Je hebt geen account nodig. Kies bovenaan in de editor je taal.

1. Voeg kamers, muren, deuren en ramen toe. De bibliotheek bevat 206 modellen. Kies een kleurenpalet en bij geschikte objecten een oppervlaktepatroon.
2. Exporteer JSON om een bewerkbare kopie te bewaren. Concepten blijven alleen in deze browser. Een taalwissel verandert je plattegrond niet.

### Optioneel: draagbare toolkit en Python-compiler

Deze route is bedoeld voor aparte builds en eerdere gegenereerde installaties; sla deze over bij een nieuwe native installatie.

Download en pak de volledige gereedschapsset uit. Installeer Python 3.10 of nieuwer. Voer in de map van de gereedschapsset het volgende uit:

[ZIP](https://github.com/ha-homelab/home-studio/releases/latest)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

De Engelse installatiehandleiding legt back-ups, Home Assistant OS, het configuratiepad en opnieuw opstarten uit. De browsereditor maakt zelf geen verbinding met Home Assistant en bedient geen apparaten.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=nl) · [README](../../README.md) · [i18n](../i18n.md)

Je plattegrond en apparaat-ID’s kunnen privé zijn. Gebruik een fictief huis voor openbare voorbeelden.

Dit is een vertaalde snelstartgids. De volledige documentatie en geïllustreerde handleiding zijn momenteel in het Engels. Verbeteringen aan vertalingen zijn welkom.

## Knoppen proberen zonder opdrachten

Zet in de geïnstalleerde Home Assistant-plattegrond Dry run aan om knoppen zonder opdrachten te proberen. Schakelaars, tv-voeding, gordijnen en ingebouwde vensters met slotbediening worden geblokkeerd; de statussen blijven echt. Bewaar het adres met ?dry_run=1 als bladwijzer in deze browser. Wijzigingen aan de indeling kunnen nog steeds worden opgeslagen.

[Dry run — English](../dry-run.md) · [Wiki — English](../wiki/Home.md)

MIT · [LICENSE](../../LICENSE)
