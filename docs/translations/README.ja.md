# Home Studio — クイックスタート

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=ja) · [Languages](README.md)

ブラウザーで自宅の間取りを描けます。アカウントは不要です。エディター上部で言語を選んでください。

1. 部屋、壁、ドア、窓を追加します。ライブラリには195種類のモデルがあります。配色を選び、対応するアイテムには表面の模様も設定できます。
2. 編集できるコピーを残すにはJSONをエクスポートしてください。下書きはこのブラウザーにのみ保存されます。言語を変更しても間取りは変わりません。

完全なツールキットをダウンロードして展開し、Python 3.10以降をインストールします。ツールキットのフォルダーで次を実行してください。

[ZIP](https://github.com/ha-homelab/home-studio/releases/latest)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

英語のインストールガイドには、バックアップ、Home Assistant OS、設定フォルダー、再起動の手順があります。ブラウザーのエディター自体はHome Assistantに接続せず、機器を操作しません。

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=ja) · [README](../../README.md) · [i18n](../i18n.md)

間取りや機器のエンティティIDは個人情報に関わる場合があります。公開する例には架空の家を使ってください。

これは翻訳版のクイックスタートです。詳しいリファレンスと図解ガイドは現在英語です。翻訳の修正を歓迎します。

## 命令を送らずにボタンを試す

インストール済みの Home Assistant の図で Dry run を有効にすると、命令を送らずにボタンを試せます。スイッチ、テレビの電源、カーテン、錠の操作を含む標準ダイアログを遮断し、実際の状態表示は続きます。このブラウザーで保護を維持するには、図の URL に ?dry_run=1 を付けてブックマークしてください。配置の変更は引き続き保存できます。

[Dry run — English](../dry-run.md) · [Wiki — English](../wiki/Home.md)

MIT · [LICENSE](../../LICENSE)
