# Home Studio — Rychlý začátek

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=cs) · [Languages](README.md)

Nakreslete svůj domov v prohlížeči. Nepotřebujete účet. Jazyk vyberete v horní části editoru.

1. Přidejte místnosti, stěny, dveře a okna. Knihovna obsahuje 195 modelů. Vyberte barevnou paletu a u podporovaných předmětů také vzor povrchu.
2. Exportujte JSON a uložte si upravitelnou kopii. Koncepty zůstávají pouze v tomto prohlížeči. Změna jazyka váš plán nezmění.

Stáhněte a rozbalte kompletní sadu nástrojů. Nainstalujte Python 3.10 nebo novější. Ve složce nástrojů spusťte:

[ZIP](https://github.com/ha-homelab/home-studio/archive/refs/heads/main.zip)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

Anglický návod k instalaci popisuje zálohy, Home Assistant OS, cestu ke konfiguraci a restart. Editor v prohlížeči se sám nepřipojuje k Home Assistant ani neovládá zařízení.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html) · [README](../../README.md) · [i18n](../i18n.md)

Plán domu a identifikátory zařízení mohou být soukromé. Ve veřejných příkladech používejte smyšlený dům.

Toto je přeložený stručný návod. Úplná dokumentace a ilustrovaný průvodce jsou zatím v angličtině. Opravy překladů vítáme.

MIT · [LICENSE](../../LICENSE)
