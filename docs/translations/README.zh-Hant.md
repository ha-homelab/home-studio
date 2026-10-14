# Home Studio — 快速入門

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=zh-Hant) · [Languages](README.md)

在瀏覽器中繪製您的家，無需帳號。在編輯器頂端選擇語言。

1. 新增房間、牆壁、門和窗戶。素材庫提供 195 種模型。選擇配色方案，並為支援的物件選擇表面圖案。
2. 匯出 JSON 以保留可編輯的副本。草稿只儲存在目前的瀏覽器中。切換語言不會改變您的平面圖。

下載並解壓縮完整工具組。安裝 Python 3.10 或更新版本。在工具組目錄中執行：

[ZIP](https://github.com/ha-homelab/home-studio/archive/refs/heads/main.zip)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

英文安裝指南介紹了備份、Home Assistant OS、設定路徑與重新啟動方式。瀏覽器編輯器本身不會連線至 Home Assistant，也不會控制裝置。

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html) · [README](../../README.md) · [i18n](../i18n.md)

家庭平面圖和裝置實體 ID 可能涉及隱私。公開分享時請使用虛構的房屋範例。

這是翻譯版快速入門指南。完整參考文件與圖文教學目前為英文。歡迎提出翻譯修正。

MIT · [LICENSE](../../LICENSE)
