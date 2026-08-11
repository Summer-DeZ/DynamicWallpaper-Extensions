# Dynamic Wallpaper Renderer

为 Windows 版 VS Code 设置图片、视频、网页或渐变动态壁纸，并支持导入 Wallpaper Engine
工程。使用时不需要运行 Steam 或 Wallpaper Engine。

## 使用

1. 安装 VSIX。
2. 在扩展列表中打开本扩展的齿轮菜单，选择“导入 Wallpaper Engine 工程”。
3. 导入完成后，运行 `Dynamic Wallpaper: 应用并重启`。

也可以通过命令面板选择现有壁纸工程或创建渐变示例。

Wallpaper Engine 的 Web 和 Video 工程可直接转换。Scene 和 Puppet 工程会尽量保留图层、
动画和粒子效果；不支持的脚本、文字和自定义着色器会跳过，并记录在转换报告中。

## 壁纸管理

通过命令面板可以选择、打开、导出或删除已导入壁纸。扩展齿轮菜单也提供“打开壁纸库”入口。

## 注意事项

- VS Code 更新后，如果壁纸失效，请重新运行 `Dynamic Wallpaper: 应用并重启`。
- 禁用或卸载扩展前，请先运行 `Dynamic Wallpaper: 禁用并恢复 Workbench`。
- 导入或分发壁纸前，请确认素材许可。

许可证：GPL-2.0-only。
