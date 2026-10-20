# Home Studio — Szybki start

[Home Studio — Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=pl#native-studio) · [Languages](README.md)

## Zacznij w Home Assistant

Dla nowego domu użyj Home Studio wewnątrz Home Assistant. Nie potrzebujesz osobnej instalacji Pythona, YAML ani tokenu dostępu.

W przypadku istniejącego wygenerowanego lub zmodyfikowanego komponentu najpierw przeczytaj **Existing generated homes** w szczegółowym przewodniku: konwersja nie jest automatyczna.

1. Użyj Home Assistant 2026.10 lub nowszego i wykonaj kopię zapasową.
2. W HACS dodaj `https://github.com/ha-homelab/home-studio` jako niestandardowe repozytorium kategorii **Integration**. Zainstaluj stabilne wydanie Home Studio zawierające **home_floorplan.zip** i uruchom ponownie Home Assistant.
3. Otwórz **Settings → Devices & services → Add integration → Home Studio**.
4. Jako administrator otwórz **Home Studio** na pasku bocznym. Narysuj pokój i powiąż obiekty z rzeczywistymi urządzeniami HA.
5. Kliknij **Save draft**, a następnie **Publish family view**. Otwórz **3D Home** i sprawdź powiązania w **Dry run** przed sterowaniem urządzeniami.

[Home Assistant guide — English](../home-assistant-editor.md) · [Install — English](https://ha-homelab.github.io/home-studio/install.html#native-studio)

## Opcjonalnie: rysowanie podczas konfiguracji HA

Możesz użyć osobnego edytora w przeglądarce podczas przygotowywania HA. Nie ma on połączenia na żywo z HA. Wyeksportuj JSON, a następnie otwórz go przez **Open JSON** w Home Studio wewnątrz HA, sprawdź urządzenia, zapisz i opublikuj.

[Browser editor](https://ha-homelab.github.io/home-studio/planner/?lang=pl)

Narysuj swój dom w przeglądarce. Konto nie jest potrzebne. Wybierz język u góry edytora.

1. Dodaj pokoje, ściany, drzwi i okna. Biblioteka zawiera 206 modeli. Wybierz paletę kolorów, a dla obsługiwanych przedmiotów także wzór powierzchni.
2. Wyeksportuj JSON, aby zachować edytowalną kopię. Szkice pozostają tylko w tej przeglądarce. Zmiana języka nie zmienia planu.

### Opcjonalnie: przenośne narzędzia i kompilator Python

Ta ścieżka służy do osobnych kompilacji i wcześniejszych wygenerowanych instalacji; pomiń ją przy nowej instalacji natywnej.

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
