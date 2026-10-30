# Home Studio — Schnellstart

[Home Studio — Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=de#native-studio) · [Languages](README.md)

## In Home Assistant beginnen

Für ein neues Zuhause verwendest du Home Studio direkt in Home Assistant. Eine separate Python-Installation, YAML und ein Zugriffstoken sind dafür nicht nötig.

Lies bei einer vorhandenen generierten oder angepassten Komponente zuerst **Existing generated homes** in der ausführlichen Anleitung: Es gibt keine automatische Konvertierung.

1. Verwende Home Assistant 2026.10 oder neuer und erstelle eine Sicherung.
2. Füge in HACS `https://github.com/ha-homelab/home-studio` als benutzerdefiniertes Repository der Kategorie **Integration** hinzu. Installiere die stabile Home-Studio-Version mit **home_floorplan.zip** und starte Home Assistant neu.
3. Öffne **Settings → Devices & services → Add integration → Home Studio**.
4. Öffne als Administrator **Home Studio** in der Seitenleiste. Zeichne einen Raum und verknüpfe die Objekte mit deinen echten HA-Geräten.
5. Klicke auf **Save draft**, dann auf **Publish family view**. Öffne **3D Home** und prüfe die Verknüpfungen mit **Dry run**, bevor du Geräte steuerst.

[Home Assistant guide — English](../home-assistant-editor.md) · [Install — English](https://ha-homelab.github.io/home-studio/install.html#native-studio)

## Optional: Zeichnen während der HA-Einrichtung

Den separaten Browser-Editor kannst du während der HA-Einrichtung nutzen. Er hat keine Live-Verbindung zu HA. Exportiere JSON und öffne es später mit **Open JSON** in Home Studio innerhalb von HA. Prüfe die Geräte, speichere und veröffentliche den Plan.

[Browser editor](https://ha-homelab.github.io/home-studio/planner/?lang=de)

Zeichne dein Zuhause im Browser. Du brauchst kein Konto. Die Sprache wählst du oben im Editor.

1. Füge Räume, Wände, Türen und Fenster hinzu. Die Bibliothek enthält 211 Modelle. Wähle eine Farbpalette und bei geeigneten Objekten ein Oberflächenmuster.
2. Exportiere JSON, um eine bearbeitbare Kopie zu sichern. Entwürfe bleiben nur in diesem Browser. Ein Sprachwechsel verändert deinen Grundriss nicht.

### Optional: Portables Werkzeugpaket und Python-Compiler

Dieser Weg ist für separate Builds und bisherige generierte Installationen gedacht; überspringe ihn bei einer neuen nativen Installation.

Lade das vollständige Werkzeugpaket herunter und entpacke es. Installiere Python 3.10 oder neuer. Führe im Paketordner Folgendes aus:

[ZIP](https://github.com/ha-homelab/home-studio/releases/latest)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

Die englische Installationsanleitung erklärt Sicherungen, Home Assistant OS, den Konfigurationspfad und den Neustart. Der Browser-Editor selbst verbindet sich nicht mit Home Assistant und steuert keine Geräte.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=de) · [README](../../README.md) · [i18n](../i18n.md)

Dein Grundriss und Gerätekennungen können vertraulich sein. Teile öffentliche Beispiele mit einem erfundenen Zuhause.

Dies ist eine übersetzte Kurzanleitung. Die vollständige Referenz und die bebilderte Anleitung sind derzeit auf Englisch. Übersetzungskorrekturen sind willkommen.

## Gerätetasten ohne Befehlsversand

Aktivieren Sie im installierten Home-Assistant-Plan Dry run, um Gerätetasten ohne Befehlsversand auszuprobieren. Schalter, TV-Stromversorgung, Vorhänge und native Dialoge mit Schlosssteuerung werden blockiert; die Zustände bleiben echt. Speichern Sie die Planadresse mit ?dry_run=1 als Lesezeichen für diesen Browser. Änderungen an der Anordnung können weiterhin gespeichert werden.

[Dry run — English](../dry-run.md) · [Wiki — English](../wiki/Home.md)

MIT · [LICENSE](../../LICENSE)
