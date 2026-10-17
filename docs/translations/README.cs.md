# Home Studio — Rychlý začátek

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=cs) · [Languages](README.md)

Nakreslete svůj domov v prohlížeči. Nepotřebujete účet. Jazyk vyberete v horní části editoru.

1. Přidejte místnosti, stěny, dveře a okna. Knihovna obsahuje 195 modelů. Vyberte barevnou paletu a u podporovaných předmětů také vzor povrchu.
2. Exportujte JSON a uložte si upravitelnou kopii. Koncepty zůstávají pouze v tomto prohlížeči. Změna jazyka váš plán nezmění.

Stáhněte a rozbalte kompletní sadu nástrojů. Nainstalujte Python 3.10 nebo novější. Ve složce nástrojů spusťte:

[ZIP](https://github.com/ha-homelab/home-studio/releases/latest)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

Anglický návod k instalaci popisuje zálohy, Home Assistant OS, cestu ke konfiguraci a restart. Editor v prohlížeči se sám nepřipojuje k Home Assistant ani neovládá zařízení.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=cs) · [README](../../README.md) · [i18n](../i18n.md)

Plán domu a identifikátory zařízení mohou být soukromé. Ve veřejných příkladech používejte smyšlený dům.

Toto je přeložený stručný návod. Úplná dokumentace a ilustrovaný průvodce jsou zatím v angličtině. Opravy překladů vítáme.

## Zkoušení tlačítek bez příkazů

V nainstalovaném plánu Home Assistant zapněte Dry run, chcete-li zkoušet tlačítka bez odesílání příkazů. Blokují se vypínače, napájení televizorů, závěsy i nativní dialogy s ovládáním zámků; stavy zůstávají skutečné. Uložte adresu plánu s ?dry_run=1 do záložek tohoto prohlížeče. Změny rozmístění lze nadále ukládat.

[Dry run — English](../dry-run.md) · [Wiki — English](../wiki/Home.md)

MIT · [LICENSE](../../LICENSE)
