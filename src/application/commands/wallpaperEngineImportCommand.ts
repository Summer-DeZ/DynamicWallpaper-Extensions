import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  importWallpaperEngineProject,
  readWallpaperEngineProject,
  WallpaperEngineImportError
} from '../../importers/wallpaperEngineImporter';
import { pathExists } from '../../platform/filesystem';
import {
  createManagedWallpaperId,
  ensureWallpaperLibrary,
  managedWallpaperDirectory,
  upsertManagedWallpaper
} from '../../project/wallpaperLibrary';
import { COMMANDS } from '../constants';
import { getWallpaperLibraryDirectory } from '../libraryStorage';
import { loadConfiguredWallpaperProject, selectManagedWallpaper } from '../settings';

export async function importWallpaperEngine(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<void> {
  const selected = await vscode.window.showOpenDialog({
    title: '选择 Wallpaper Engine 工程文件夹（包含 project.json）',
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false
  });
  if (!selected?.[0]) {
    return;
  }

  const sourceDirectory = path.resolve(selected[0].fsPath);
  let overwrite = false;
  try {
    const sourceProject = await readWallpaperEngineProject(sourceDirectory);
    const libraryDirectory = getWallpaperLibraryDirectory(context);
    await ensureWallpaperLibrary(libraryDirectory);
    const wallpaperId = createManagedWallpaperId(sourceDirectory, {
      title: sourceProject.title,
      workshopId: sourceProject.workshopid
    });
    const outputDirectory = managedWallpaperDirectory(libraryDirectory, wallpaperId);
    if (await pathExists(outputDirectory)) {
      const confirmation = await vscode.window.showWarningMessage(
        `壁纸库中已存在“${sourceProject.title}”。成功转换并验证后更新它吗？`,
        { modal: true },
        '覆盖'
      );
      if (confirmation !== '覆盖') {
        return;
      }
      overwrite = true;
    }

    output.clear();
    output.appendLine(`源工程：${sourceDirectory}`);
    output.appendLine(`壁纸库：${libraryDirectory}`);
    output.appendLine(`转换目标：${outputDirectory}`);
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '正在转换 Wallpaper Engine 工程',
        cancellable: true
      },
      (progress, token) => importWallpaperEngineProject({
        sourceDirectory,
        outputDirectory,
        extensionPath: context.extensionPath,
        overwrite,
        isCancellationRequested: () => token.isCancellationRequested,
        onProgress: update => {
          progress.report({ message: update.message, increment: update.increment });
          output.appendLine(update.message);
        }
      })
    );

    await loadConfiguredWallpaperProject(result.projectFile);
    await upsertManagedWallpaper(libraryDirectory, {
      id: wallpaperId,
      title: result.title,
      sourceType: result.sourceType,
      sourceDirectory: result.sourceDirectory
    });
    await selectManagedWallpaper(context, wallpaperId);
    output.appendLine(`转换完成：${result.outputDirectory}`);
    for (const warning of result.warnings) {
      output.appendLine(`注意：${warning}`);
    }

    const action = await vscode.window.showInformationMessage(
      `已转换“${result.title}”，并设为当前壁纸工程。`,
      '应用并重启',
      '打开文件夹',
      '查看转换报告'
    );
    if (action === '应用并重启') {
      await vscode.commands.executeCommand(COMMANDS.apply);
    } else if (action === '打开文件夹') {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.outputDirectory));
    } else if (action === '查看转换报告') {
      const document = await vscode.workspace.openTextDocument(result.reportFile);
      await vscode.window.showTextDocument(document);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`转换失败：${message}`);
    if (error instanceof WallpaperEngineImportError) {
      for (const detail of error.details) {
        output.appendLine(`  ${detail}`);
      }
    }
    const action = await vscode.window.showErrorMessage(
      `Wallpaper Engine 工程转换失败：${message}`,
      '查看详情'
    );
    if (action === '查看详情') {
      output.show(true);
    }
  }
}
