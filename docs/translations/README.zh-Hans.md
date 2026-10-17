# Home Studio — 快速入门

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=zh-Hans) · [Languages](README.md)

在浏览器中绘制您的家，无需账户。在编辑器顶部选择语言。

1. 添加房间、墙壁、门和窗户。素材库提供 195 种模型。选择配色方案，并为支持的物品选择表面图案。
2. 导出 JSON 以保留可编辑副本。草稿只保存在当前浏览器中。切换语言不会改变您的平面图。

下载并解压完整工具包。安装 Python 3.10 或更新版本。在工具包目录中运行：

[ZIP](https://github.com/ha-homelab/home-studio/releases/latest)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

英文安装指南介绍了备份、Home Assistant OS、配置路径和重启方法。浏览器编辑器本身不会连接 Home Assistant，也不会控制设备。

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=zh-Hans) · [README](../../README.md) · [i18n](../i18n.md)

家庭平面图和设备实体 ID 可能涉及隐私。公开分享时请使用虚构的房屋示例。

这是翻译版快速入门指南。完整参考文档和图文教程目前为英文。欢迎提出翻译修正。

## 不发送命令地试用按钮

在已安装的 Home Assistant 平面图中启用 Dry run，即可在不发送命令的情况下试用按钮。开关、电视电源、窗帘以及包含门锁控制的原生对话框会被阻止，状态仍显示真实数据。将平面图地址加上 ?dry_run=1 后保存为此浏览器的书签，可固定启用此模式。布局修改仍可保存。

[Dry run — English](../dry-run.md) · [Wiki — English](../wiki/Home.md)

MIT · [LICENSE](../../LICENSE)
