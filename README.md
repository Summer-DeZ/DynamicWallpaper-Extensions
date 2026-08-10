# Dynamic Wallpaper Renderer

为 Windows 桌面版 VS Code 添加图片、视频、网页或渐变动态壁纸，也可导入 Wallpaper Engine
工程。运行时不依赖 Steam 或 Wallpaper Engine。

> 插件通过修改 Workbench HTML 实现，这不是 VS Code 官方扩展 API。VS Code 更新后可能需要
> 重新执行“应用并重启”。

## 使用

1. 安装 VSIX。
2. 打开命令面板，选择一种方式：
   - `Dynamic Wallpaper: 选择壁纸文件夹`：选择包含 `wallpaper.json` 的现有工程。
   - `Dynamic Wallpaper: 导入 Wallpaper Engine 工程`：选择包含 `project.json` 的工程。
   - `Dynamic Wallpaper: 创建示例壁纸工程`：创建一个渐变示例。
3. 运行 `Dynamic Wallpaper: 应用并重启`。

支持视频、图片、本地 Web 页面和动态渐变。Wallpaper Engine 的 Web、Video 工程可以转换；
Scene 工程会尽可能提取可用媒体，不支持的粒子、脚本和着色器会记录在转换报告中。

## 壁纸库

导入结果默认保存在 VS Code 为扩展提供的 `globalStorageUri` 中，不会写入插件安装包或 Steam
源目录。可通过以下命令选择、打开、导出或删除已导入壁纸：

- `Dynamic Wallpaper: 选择已导入壁纸`
- `Dynamic Wallpaper: 打开壁纸库`
- `Dynamic Wallpaper: 导出已导入壁纸`
- `Dynamic Wallpaper: 删除已导入壁纸`

若要使用固定位置，请设置绝对路径 `dynamicWallpaper.libraryDirectory`。导入和分发壁纸前，
请自行确认素材许可。

## 注意

- 打开图片、视频或 PDF 时，编辑器区域默认恢复为不透明，避免内容与壁纸重叠。
- 正常禁用或卸载前，请先运行 `Dynamic Wallpaper: 禁用并恢复 Workbench`。
- `dynamicWallpaper.preferHighPerformanceGpu` 默认为 `true`。
- `dynamicWallpaper.wallpaperOpacity` 可覆盖壁纸透明度，`-1` 表示跟随工程。
- `dynamicWallpaper.playbackRate` 可覆盖视频速度，`0` 表示跟随工程。
- 壁纸工程格式由 `schemas/wallpaper.schema.json` 描述，相对资源路径以 `wallpaper.json` 所在目录为准。

## 开发

```powershell
npm install
npm run check
npm run package
```

许可证：GPL-2.0-only。
