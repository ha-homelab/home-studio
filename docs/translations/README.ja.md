# Home Studio — クイックスタート

[Home Studio — Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=ja#native-studio) · [Languages](README.md)

## Home Assistant から始める

新しい家の設定には、Home Assistant 内の Home Studio を使います。Python の別途インストール、YAML、アクセストークンは不要です。

生成済みまたはカスタマイズ済みのコンポーネントを使用している場合は、先に詳細ガイドの **Existing generated homes** を読んでください。自動変換は行われません。

1. Home Assistant 2026.10 以降を使用し、バックアップを作成します。
2. HACS で `https://github.com/ha-homelab/home-studio` をカテゴリ **Integration** のカスタムリポジトリとして追加します。**home_floorplan.zip** を含む Home Studio の安定版をインストールし、Home Assistant を再起動します。
3. **Settings → Devices & services → Add integration → Home Studio** を開きます。
4. 管理者アカウントでサイドバーの **Home Studio** を開きます。部屋を描き、各アイテムを実際の HA デバイスに関連付けます。
5. **Save draft**、次に **Publish family view** を押します。**3D Home** を開き、デバイスを操作する前に **Dry run** で関連付けを確認します。

[Home Assistant guide — English](../home-assistant-editor.md) · [Install — English](https://ha-homelab.github.io/home-studio/install.html#native-studio)

## 任意：HA の準備中に図面を描く

HA の準備中は、独立したブラウザーエディターも使えます。このエディターは HA にリアルタイム接続しません。JSON をエクスポートし、準備できたら HA 内の Home Studio で **Open JSON** を使って読み込み、デバイスを確認して保存・公開します。

[Browser editor](https://ha-homelab.github.io/home-studio/planner/?lang=ja)

ブラウザーで自宅の間取りを描けます。アカウントは不要です。エディター上部で言語を選んでください。

1. 部屋、壁、ドア、窓を追加します。ライブラリには206種類のモデルがあります。配色を選び、対応するアイテムには表面の模様も設定できます。
2. 編集できるコピーを残すにはJSONをエクスポートしてください。下書きはこのブラウザーにのみ保存されます。言語を変更しても間取りは変わりません。

### 任意：ポータブルツールと Python コンパイラー

この手順は個別のビルドや従来の生成済み環境向けです。新しいネイティブ環境の導入では省略してください。

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
