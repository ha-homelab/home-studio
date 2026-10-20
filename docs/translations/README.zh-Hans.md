# Home Studio — 快速入门

[Home Studio — Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=zh-Hans#native-studio) · [Languages](README.md)

## 从 Home Assistant 开始

新建家庭项目时，请使用 Home Assistant 内的 Home Studio。无需单独安装 Python、编写 YAML 或创建访问令牌。

如果已有生成式或自定义组件，请先阅读详细指南中的 **Existing generated homes**；系统不会自动转换这些组件。

1. 使用 Home Assistant 2026.10 或更新版本，并先创建备份。
2. 在 HACS 中将 `https://github.com/ha-homelab/home-studio` 添加为自定义仓库，类别选择 **Integration**。安装包含 **home_floorplan.zip** 的 Home Studio 稳定版，然后重启 Home Assistant。
3. 打开 **Settings → Devices & services → Add integration → Home Studio**。
4. 使用管理员账户打开侧边栏中的 **Home Studio**。绘制房间，并将物品绑定到真实的 HA 设备。
5. 点击 **Save draft**，再点击 **Publish family view**。打开 **3D Home**，先用 **Dry run** 检查绑定，再控制设备。

[Home Assistant guide — English](../home-assistant-editor.md) · [Install — English](https://ha-homelab.github.io/home-studio/install.html#native-studio)

## 可选：配置 HA 期间先绘图

在准备 HA 时，可以使用独立的浏览器编辑器。它没有与 HA 的实时连接。导出 JSON，待 HA 就绪后在其中的 Home Studio 使用 **Open JSON** 导入，检查设备、保存并发布。

[Browser editor](https://ha-homelab.github.io/home-studio/planner/?lang=zh-Hans)

在浏览器中绘制您的家，无需账户。在编辑器顶部选择语言。

1. 添加房间、墙壁、门和窗户。素材库提供 206 种模型。选择配色方案，并为支持的物品选择表面图案。
2. 导出 JSON 以保留可编辑副本。草稿只保存在当前浏览器中。切换语言不会改变您的平面图。

### 可选：便携工具包与 Python 编译器

此流程适用于单独构建及原有的生成式安装；新的原生安装请跳过。

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
