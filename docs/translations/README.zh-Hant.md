# Home Studio — 快速入門

[Home Studio — Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=zh-Hant#native-studio) · [Languages](README.md)

## 從 Home Assistant 開始

建立新的家庭專案時，請使用 Home Assistant 內的 Home Studio。無需另外安裝 Python、編寫 YAML 或建立存取權杖。

如果已有產生式或自訂元件，請先閱讀詳細指南中的 **Existing generated homes**；系統不會自動轉換這些元件。

1. 使用 Home Assistant 2026.10 或更新版本，並先建立備份。
2. 在 HACS 中將 `https://github.com/ha-homelab/home-studio` 新增為自訂儲存庫，類別選擇 **Integration**。安裝包含 **home_floorplan.zip** 的 Home Studio 穩定版，然後重新啟動 Home Assistant。
3. 開啟 **Settings → Devices & services → Add integration → Home Studio**。
4. 使用管理員帳號開啟側邊欄中的 **Home Studio**。繪製房間，並將物件綁定至真實的 HA 裝置。
5. 按一下 **Save draft**，再按 **Publish family view**。開啟 **3D Home**，先用 **Dry run** 檢查綁定，再控制裝置。

[Home Assistant guide — English](../home-assistant-editor.md) · [Install — English](https://ha-homelab.github.io/home-studio/install.html#native-studio)

## 選用：設定 HA 期間先繪圖

準備 HA 時，可以使用獨立的瀏覽器編輯器。它沒有與 HA 的即時連線。匯出 JSON，待 HA 就緒後在其中的 Home Studio 使用 **Open JSON** 匯入，檢查裝置、儲存並發布。

[Browser editor](https://ha-homelab.github.io/home-studio/planner/?lang=zh-Hant)

在瀏覽器中繪製您的家，無需帳號。在編輯器頂端選擇語言。

1. 新增房間、牆壁、門和窗戶。素材庫提供 206 種模型。選擇配色方案，並為支援的物件選擇表面圖案。
2. 匯出 JSON 以保留可編輯的副本。草稿只儲存在目前的瀏覽器中。切換語言不會改變您的平面圖。

### 選用：可攜式工具組與 Python 編譯器

此流程適用於獨立建置及原有的產生式安裝；新的原生安裝請略過。

下載並解壓縮完整工具組。安裝 Python 3.10 或更新版本。在工具組目錄中執行：

[ZIP](https://github.com/ha-homelab/home-studio/releases/latest)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

英文安裝指南介紹了備份、Home Assistant OS、設定路徑與重新啟動方式。瀏覽器編輯器本身不會連線至 Home Assistant，也不會控制裝置。

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=zh-Hant) · [README](../../README.md) · [i18n](../i18n.md)

家庭平面圖和裝置實體 ID 可能涉及隱私。公開分享時請使用虛構的房屋範例。

這是翻譯版快速入門指南。完整參考文件與圖文教學目前為英文。歡迎提出翻譯修正。

## 不傳送指令地試用按鈕

在已安裝的 Home Assistant 平面圖中啟用 Dry run，即可不傳送指令地試用按鈕。開關、電視電源、窗簾及包含門鎖控制的原生對話框會被阻擋，狀態仍顯示真實資料。將平面圖網址加上 ?dry_run=1 後儲存為此瀏覽器的書籤，可固定啟用此模式。配置修改仍可儲存。

[Dry run — English](../dry-run.md) · [Wiki — English](../wiki/Home.md)

MIT · [LICENSE](../../LICENSE)
