# Dynamic Wallpaper Renderer

在 Windows 版 VS Code 中使用动态壁纸，并支持导入 Wallpaper Engine 的 Scene、Web 和 Video 工程。

## 使用

1. 安装 VSIX 并重启 VS Code。
2. 按 `Ctrl+Shift+P`，运行 `Dynamic Wallpaper: 导入 Wallpaper Engine 工程`。
3. 选择包含 `project.json` 的工程文件夹。
4. 导入完成后选择“立即切换”；也可选择“继续导入”批量加入壁纸库。
5. 之后运行 `Dynamic Wallpaper: 浏览并切换壁纸库`，即可搜索并一键切换任意已导入项目。

## 常用命令

- `Dynamic Wallpaper: 浏览并切换壁纸库`
- `Dynamic Wallpaper: 打开壁纸用户属性`
- `Dynamic Wallpaper: 打开兼容性报告/运行时诊断`
- `Dynamic Wallpaper: 管理当前壁纸网络授权`
- `Dynamic Wallpaper: 在资源管理器中打开壁纸库`
- `Dynamic Wallpaper: 删除已导入壁纸`
- `Dynamic Wallpaper: 禁用并恢复 Workbench`

卸载扩展后重启 VS Code，会自动删除已转换的 Wallpaper Engine 壁纸库。

## 帧率

在 VS Code 设置中修改 `Dynamic Wallpaper: Max Fps`，可设置为 15–60 FPS；建议使用 30 FPS 降低 GPU 占用。

`Dynamic Wallpaper: Pause When Unfocused` 默认开启。开启时，切换到其他应用或最小化 VS Code 会暂停壁纸的视频、音频、动画、脚本和 WebGL 更新，回到 VS Code 后自动恢复；用户可在设置中关闭。

## PDF 与图片

打开 PDF 或常见图片时，对应编辑器分组会自动恢复为完全不透明，避免壁纸干扰内容。可在 VS Code 设置中修改 `Dynamic Wallpaper: Opaque Editor File Types`，添加或删除扩展名；设为空数组可关闭此行为。修改后按提示重新应用并重启。
