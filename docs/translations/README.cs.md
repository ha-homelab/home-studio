# Home Studio — Rychlý začátek

[Home Studio — Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=cs#native-studio) · [Languages](README.md)

## Začněte v Home Assistant

Pro nový domov použijte Home Studio přímo v Home Assistant. Samostatná instalace Pythonu, YAML ani přístupový token nejsou potřeba.

U existující vygenerované nebo upravené komponenty si nejprve přečtěte **Existing generated homes** v podrobném průvodci: převod není automatický.

1. Použijte Home Assistant 2026.10 nebo novější a vytvořte zálohu.
2. V HACS přidejte `https://github.com/ha-homelab/home-studio` jako vlastní repozitář v kategorii **Integration**. Nainstalujte stabilní vydání Home Studio obsahující **home_floorplan.zip** a restartujte Home Assistant.
3. Otevřete **Settings → Devices & services → Add integration → Home Studio**.
4. Jako správce otevřete **Home Studio** v postranním panelu. Nakreslete místnost a propojte předměty se skutečnými zařízeními HA.
5. Klikněte na **Save draft** a poté na **Publish family view**. Otevřete **3D Home** a ověřte propojení pomocí **Dry run**, než začnete zařízení ovládat.

[Home Assistant guide — English](../home-assistant-editor.md) · [Install — English](https://ha-homelab.github.io/home-studio/install.html#native-studio)

## Volitelně: kreslení během nastavování HA

Během přípravy HA můžete použít samostatný editor v prohlížeči. Nemá živé připojení k HA. Exportujte JSON, pak jej otevřete pomocí **Open JSON** v Home Studio uvnitř HA, zkontrolujte zařízení, uložte a publikujte.

[Browser editor](https://ha-homelab.github.io/home-studio/planner/?lang=cs)

Nakreslete svůj domov v prohlížeči. Nepotřebujete účet. Jazyk vyberete v horní části editoru.

1. Přidejte místnosti, stěny, dveře a okna. Knihovna obsahuje 211 modelů. Vyberte barevnou paletu a u podporovaných předmětů také vzor povrchu.
2. Exportujte JSON a uložte si upravitelnou kopii. Koncepty zůstávají pouze v tomto prohlížeči. Změna jazyka váš plán nezmění.

### Volitelně: přenosná sada nástrojů a kompilátor Python

Tato cesta slouží pro samostatné sestavení a dřívější vygenerované instalace; u nové nativní instalace ji přeskočte.

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
