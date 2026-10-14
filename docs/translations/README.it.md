# Home Studio — Guida rapida

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=it) · [Languages](README.md)

Disegna la tua casa nel browser. Non serve un account. Scegli la lingua nella parte superiore dell’editor.

1. Aggiungi stanze, pareti, porte e finestre. La libreria include 195 modelli. Scegli una tavolozza di colori e, per gli oggetti compatibili, un motivo della superficie.
2. Esporta JSON per conservare una copia modificabile. Le bozze restano solo in questo browser. Cambiare lingua non modifica la pianta.

Scarica ed estrai il pacchetto completo degli strumenti. Installa Python 3.10 o successivo. Nella cartella degli strumenti esegui:

[ZIP](https://github.com/ha-homelab/home-studio/archive/refs/heads/main.zip)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

La guida d’installazione in inglese spiega backup, Home Assistant OS, percorso di configurazione e riavvio. L’editor web non si collega direttamente a Home Assistant e non controlla dispositivi.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=it) · [README](../../README.md) · [i18n](../i18n.md)

La pianta e gli identificativi dei dispositivi possono essere riservati. Usa una casa immaginaria negli esempi pubblici.

Questa è una guida rapida tradotta. La documentazione completa e la guida illustrata sono attualmente in inglese. Le correzioni delle traduzioni sono benvenute.

MIT · [LICENSE](../../LICENSE)
