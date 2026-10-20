# Home Studio — Guida rapida

[Home Studio — Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=it#native-studio) · [Languages](README.md)

## Inizia in Home Assistant

Per una nuova casa, usa Home Studio all’interno di Home Assistant. Non servono un’installazione separata di Python, YAML o un token di accesso.

Se usi già un componente generato o personalizzato, leggi prima **Existing generated homes** nella guida dettagliata: la conversione non è automatica.

1. Usa Home Assistant 2026.10 o successivo ed esegui un backup.
2. In HACS, aggiungi `https://github.com/ha-homelab/home-studio` come repository personalizzato nella categoria **Integration**. Installa la versione stabile di Home Studio che contiene **home_floorplan.zip** e riavvia Home Assistant.
3. Apri **Settings → Devices & services → Add integration → Home Studio**.
4. Con un account amministratore, apri **Home Studio** nella barra laterale. Disegna una stanza e associa gli oggetti ai dispositivi reali di HA.
5. Premi **Save draft**, poi **Publish family view**. Apri **3D Home** e verifica le associazioni con **Dry run** prima di controllare i dispositivi.

[Home Assistant guide — English](../home-assistant-editor.md) · [Install — English](https://ha-homelab.github.io/home-studio/install.html#native-studio)

## Facoltativo: disegnare durante la configurazione di HA

Puoi usare l’editor web separato mentre prepari HA. Non ha una connessione in tempo reale con HA. Esporta il JSON, poi aprilo con **Open JSON** in Home Studio all’interno di HA, verifica i dispositivi, salva e pubblica.

[Browser editor](https://ha-homelab.github.io/home-studio/planner/?lang=it)

Disegna la tua casa nel browser. Non serve un account. Scegli la lingua nella parte superiore dell’editor.

1. Aggiungi stanze, pareti, porte e finestre. La libreria include 206 modelli. Scegli una tavolozza di colori e, per gli oggetti compatibili, un motivo della superficie.
2. Esporta JSON per conservare una copia modificabile. Le bozze restano solo in questo browser. Cambiare lingua non modifica la pianta.

### Facoltativo: strumenti portabili e compilatore Python

Questo percorso serve per compilazioni separate e precedenti installazioni generate; saltalo per una nuova installazione nativa.

Scarica ed estrai il pacchetto completo degli strumenti. Installa Python 3.10 o successivo. Nella cartella degli strumenti esegui:

[ZIP](https://github.com/ha-homelab/home-studio/releases/latest)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

La guida d’installazione in inglese spiega backup, Home Assistant OS, percorso di configurazione e riavvio. L’editor web non si collega direttamente a Home Assistant e non controlla dispositivi.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=it) · [README](../../README.md) · [i18n](../i18n.md)

La pianta e gli identificativi dei dispositivi possono essere riservati. Usa una casa immaginaria negli esempi pubblici.

Questa è una guida rapida tradotta. La documentazione completa e la guida illustrata sono attualmente in inglese. Le correzioni delle traduzioni sono benvenute.

## Provare i pulsanti senza comandi

Nel piano Home Assistant installato, attiva Dry run per provare i pulsanti senza inviare comandi. Interruttori, alimentazione dei televisori, tende e finestre native con controlli delle serrature vengono bloccati; gli stati restano reali. Salva l’indirizzo del piano con ?dry_run=1 nei preferiti di questo browser. Le modifiche alla disposizione possono ancora essere salvate.

[Dry run — English](../dry-run.md) · [Wiki — English](../wiki/Home.md)

MIT · [LICENSE](../../LICENSE)
