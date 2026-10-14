# Home Studio — Início rápido

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=pt) · [Languages](README.md)

Desenhe sua casa no navegador. Não é necessário criar uma conta. Escolha o idioma na parte superior do editor.

1. Adicione cômodos, paredes, portas e janelas. A biblioteca inclui 195 modelos. Escolha uma paleta de cores e, nos objetos compatíveis, um padrão de superfície.
2. Exporte JSON para guardar uma cópia editável. Os rascunhos ficam apenas neste navegador. Mudar o idioma não altera sua planta.

Baixe e extraia o conjunto completo de ferramentas. Instale Python 3.10 ou mais recente. Na pasta das ferramentas, execute:

[ZIP](https://github.com/ha-homelab/home-studio/archive/refs/heads/main.zip)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

O guia de instalação em inglês explica os backups, Home Assistant OS, o caminho da configuração e a reinicialização. O editor no navegador não se conecta diretamente ao Home Assistant nem controla dispositivos.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=pt) · [README](../../README.md) · [i18n](../i18n.md)

Sua planta e os identificadores dos dispositivos podem ser privados. Use uma casa fictícia nos exemplos públicos.

Este é um guia rápido traduzido. A documentação completa e o guia ilustrado estão atualmente em inglês. Correções de tradução são bem-vindas.

MIT · [LICENSE](../../LICENSE)
