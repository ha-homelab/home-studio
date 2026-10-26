# Home Studio — Inicio rápido

[Home Studio — Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=es#native-studio) · [Languages](README.md)

## Empieza en Home Assistant

Para una casa nueva, utiliza Home Studio dentro de Home Assistant. No necesitas instalar Python por separado, escribir YAML ni crear un token de acceso.

Si ya tienes un componente generado o personalizado, lee primero **Existing generated homes** en la guía detallada: la conversión no es automática.

1. Usa Home Assistant 2026.10 o posterior y realiza una copia de seguridad.
2. En HACS, añade `https://github.com/ha-homelab/home-studio` como repositorio personalizado de categoría **Integration**. Instala la versión estable de Home Studio que contiene **home_floorplan.zip** y reinicia Home Assistant.
3. Abre **Settings → Devices & services → Add integration → Home Studio**.
4. Con una cuenta de administrador, abre **Home Studio** en la barra lateral. Dibuja una habitación y vincula los objetos con los dispositivos reales de HA.
5. Pulsa **Save draft** y después **Publish family view**. Abre **3D Home** y comprueba los vínculos con **Dry run** antes de controlar los dispositivos.

[Home Assistant guide — English](../home-assistant-editor.md) · [Install — English](https://ha-homelab.github.io/home-studio/install.html#native-studio)

## Opcional: dibujar mientras configuras HA

Puedes usar el editor web independiente mientras preparas HA. No tiene conexión en directo con HA. Exporta el JSON y después ábrelo con **Open JSON** en Home Studio dentro de HA, comprueba los dispositivos, guarda y publica.

[Browser editor](https://ha-homelab.github.io/home-studio/planner/?lang=es)

Dibuja tu casa en el navegador. No necesitas una cuenta. Elige el idioma en la parte superior del editor.

1. Añade habitaciones, paredes, puertas y ventanas. La biblioteca incluye 211 modelos. Elige una paleta de colores y, en los objetos compatibles, un patrón de superficie.
2. Exporta JSON para guardar una copia editable. Los borradores permanecen solo en este navegador. Cambiar el idioma no modifica tu plano.

### Opcional: herramientas portátiles y compilador Python

Esta ruta sirve para compilaciones independientes e instalaciones generadas anteriores; omítela en una nueva instalación nativa.

Descarga y descomprime el conjunto completo de herramientas. Instala Python 3.10 o posterior. En la carpeta de las herramientas, ejecuta:

[ZIP](https://github.com/ha-homelab/home-studio/releases/latest)

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
