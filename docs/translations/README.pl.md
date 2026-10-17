# Home Studio — Szybki start

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=pl) · [Languages](README.md)

Narysuj swój dom w przeglądarce. Konto nie jest potrzebne. Wybierz język u góry edytora.

1. Dodaj pokoje, ściany, drzwi i okna. Biblioteka zawiera 195 modeli. Wybierz paletę kolorów, a dla obsługiwanych przedmiotów także wzór powierzchni.
2. Wyeksportuj JSON, aby zachować edytowalną kopię. Szkice pozostają tylko w tej przeglądarce. Zmiana języka nie zmienia planu.

Pobierz i rozpakuj pełny zestaw narzędzi. Zainstaluj Python 3.10 lub nowszy. W folderze narzędzi uruchom:

[ZIP](https://github.com/ha-homelab/home-studio/releases/latest)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

Angielska instrukcja instalacji opisuje kopie zapasowe, Home Assistant OS, ścieżkę konfiguracji i ponowne uruchomienie. Edytor w przeglądarce sam nie łączy się z Home Assistant ani nie steruje urządzeniami.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=pl) · [README](../../README.md) · [i18n](../i18n.md)

Plan domu i identyfikatory urządzeń mogą być poufne. W publicznych przykładach używaj fikcyjnego domu.

To przetłumaczona instrukcja szybkiego startu. Pełna dokumentacja i ilustrowany przewodnik są obecnie po angielsku. Poprawki tłumaczeń są mile widziane.

## Sprawdzanie przycisków bez poleceń

W zainstalowanym planie Home Assistant włącz Dry run, aby sprawdzać przyciski bez wysyłania poleceń. Przełączniki, zasilanie telewizorów, zasłony i okna systemowe z obsługą zamków są blokowane; stany pozostają rzeczywiste. Zapisz adres planu z ?dry_run=1 w zakładkach tej przeglądarki. Zmiany rozmieszczenia obiektów nadal można zapisywać.

[Dry run — English](../dry-run.md) · [Wiki — English](../wiki/Home.md)

MIT · [LICENSE](../../LICENSE)
