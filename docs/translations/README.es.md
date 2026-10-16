# Home Studio — Inicio rápido

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=es) · [Languages](README.md)

Dibuja tu casa en el navegador. No necesitas una cuenta. Elige el idioma en la parte superior del editor.

1. Añade habitaciones, paredes, puertas y ventanas. La biblioteca incluye 195 modelos. Elige una paleta de colores y, en los objetos compatibles, un patrón de superficie.
2. Exporta JSON para guardar una copia editable. Los borradores permanecen solo en este navegador. Cambiar el idioma no modifica tu plano.

Descarga y descomprime el conjunto completo de herramientas. Instala Python 3.10 o posterior. En la carpeta de las herramientas, ejecuta:

[ZIP](https://github.com/ha-homelab/home-studio/archive/refs/heads/main.zip)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

La guía de instalación en inglés explica las copias de seguridad, Home Assistant OS, la ruta de configuración y el reinicio. El editor web no se conecta por sí mismo a Home Assistant ni controla dispositivos.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=es) · [README](../../README.md) · [i18n](../i18n.md)

Tu plano y los identificadores de dispositivos pueden ser privados. Usa una casa ficticia para los ejemplos públicos.

Esta es una guía rápida traducida. La documentación completa y la guía ilustrada están actualmente en inglés. Se agradecen las correcciones de traducción.

## Probar controles sin enviar órdenes

En el plano instalado de Home Assistant, active Dry run para probar los botones sin enviar órdenes. Se bloquean los interruptores, la alimentación de televisores, las cortinas y los diálogos nativos con controles de cerraduras; los estados siguen siendo reales. Guarde la dirección del plano con ?dry_run=1 en los marcadores de este navegador. Los cambios de distribución aún se pueden guardar.

[Dry run — English](../dry-run.md) · [Wiki — English](../wiki/Home.md)

MIT · [LICENSE](../../LICENSE)
