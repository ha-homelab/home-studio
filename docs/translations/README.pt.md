# Home Studio — Início rápido

[Home Studio — Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=pt#native-studio) · [Languages](README.md)

## Comece no Home Assistant

Para uma casa nova, use o Home Studio dentro do Home Assistant. Não é necessário instalar Python separadamente, escrever YAML ou criar um token de acesso.

Se já usa um componente gerado ou personalizado, leia primeiro **Existing generated homes** no guia detalhado: a conversão não é automática.

1. Use o Home Assistant 2026.10 ou mais recente e faça um backup.
2. No HACS, adicione `https://github.com/ha-homelab/home-studio` como repositório personalizado da categoria **Integration**. Instale a versão estável do Home Studio que contém **home_floorplan.zip** e reinicie o Home Assistant.
3. Abra **Settings → Devices & services → Add integration → Home Studio**.
4. Com uma conta de administrador, abra **Home Studio** na barra lateral. Desenhe um cômodo e vincule os objetos aos dispositivos reais do HA.
5. Clique em **Save draft** e depois em **Publish family view**. Abra **3D Home** e verifique os vínculos com **Dry run** antes de controlar os dispositivos.

[Home Assistant guide — English](../home-assistant-editor.md) · [Install — English](https://ha-homelab.github.io/home-studio/install.html#native-studio)

## Opcional: desenhar enquanto configura o HA

O editor web separado pode ajudar enquanto o HA é preparado. Ele não tem conexão ao vivo com o HA. Exporte o JSON e depois abra-o com **Open JSON** no Home Studio dentro do HA, verifique os dispositivos, salve e publique.

[Browser editor](https://ha-homelab.github.io/home-studio/planner/?lang=pt)

Desenhe sua casa no navegador. Não é necessário criar uma conta. Escolha o idioma na parte superior do editor.

1. Adicione cômodos, paredes, portas e janelas. A biblioteca inclui 211 modelos. Escolha uma paleta de cores e, nos objetos compatíveis, um padrão de superfície.
2. Exporte JSON para guardar uma cópia editável. Os rascunhos ficam apenas neste navegador. Mudar o idioma não altera sua planta.

### Opcional: ferramentas portáteis e compilador Python

Este caminho serve para compilações separadas e instalações geradas anteriores; ignore-o em uma nova instalação nativa.

Baixe e extraia o conjunto completo de ferramentas. Instale Python 3.10 ou mais recente. Na pasta das ferramentas, execute:

[ZIP](https://github.com/ha-homelab/home-studio/releases/latest)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

O guia de instalação em inglês explica os backups, Home Assistant OS, o caminho da configuração e a reinicialização. O editor no navegador não se conecta diretamente ao Home Assistant nem controla dispositivos.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=pt) · [README](../../README.md) · [i18n](../i18n.md)

Sua planta e os identificadores dos dispositivos podem ser privados. Use uma casa fictícia nos exemplos públicos.

Este é um guia rápido traduzido. A documentação completa e o guia ilustrado estão atualmente em inglês. Correções de tradução são bem-vindas.

## Testar botões sem comandos

Na planta instalada do Home Assistant, ative Dry run para testar os botões sem enviar comandos. Interruptores, alimentação dos televisores, cortinas e janelas nativas com controles de fechaduras ficam bloqueados; os estados continuam reais. Guarde o endereço da planta com ?dry_run=1 nos favoritos deste navegador. As alterações de disposição ainda podem ser guardadas.

[Dry run — English](../dry-run.md) · [Wiki — English](../wiki/Home.md)

MIT · [LICENSE](../../LICENSE)
