# Home Studio — Schnellstart

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=de) · [Languages](README.md)

Zeichne dein Zuhause im Browser. Du brauchst kein Konto. Die Sprache wählst du oben im Editor.

1. Füge Räume, Wände, Türen und Fenster hinzu. Die Bibliothek enthält 195 Modelle. Wähle eine Farbpalette und bei geeigneten Objekten ein Oberflächenmuster.
2. Exportiere JSON, um eine bearbeitbare Kopie zu sichern. Entwürfe bleiben nur in diesem Browser. Ein Sprachwechsel verändert deinen Grundriss nicht.

Lade das vollständige Werkzeugpaket herunter und entpacke es. Installiere Python 3.10 oder neuer. Führe im Paketordner Folgendes aus:

[ZIP](https://github.com/ha-homelab/home-studio/archive/refs/heads/main.zip)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

Die englische Installationsanleitung erklärt Sicherungen, Home Assistant OS, den Konfigurationspfad und den Neustart. Der Browser-Editor selbst verbindet sich nicht mit Home Assistant und steuert keine Geräte.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html) · [README](../../README.md) · [i18n](../i18n.md)

Dein Grundriss und Gerätekennungen können vertraulich sein. Teile öffentliche Beispiele mit einem erfundenen Zuhause.

Dies ist eine übersetzte Kurzanleitung. Die vollständige Referenz und die bebilderte Anleitung sind derzeit auf Englisch. Übersetzungskorrekturen sind willkommen.

MIT · [LICENSE](../../LICENSE)
