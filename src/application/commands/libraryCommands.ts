import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { pathExists } from '../../platform/filesystem';
import { removeWorkbenchPatch } from '../../platform/workbench/workbenchPatch';
import {
  ensureWallpaperLibrary,
  listExistingManagedWallpapers,
  ManagedWallpaperEntry,
  managedWallpaperDirectory,
  removeManagedWallpaperFromCatalog
} from '../../project/wallpaperLibrary';
import { COMMANDS, STATE_KEYS } from '../constants';
import { showOperationError } from '../errors';
import { getWallpaperLibraryDirectory } from '../libraryStorage';
import {
  clearProjectSelection,
  getActiveManagedWallpaperId,
  loadConfiguredWallpaperProject,
  selectManagedWallpaper
} from '../settings';

interface WallpaperQuickPickItem extends vscode.QuickPickItem {
  entry: ManagedWallpaperEntry;
}

export async function selectImportedWallpaper(context: vscode.ExtensionContext): Promise<void> {
  try {
    const selection = await chooseManagedWallpaper(context, '选择一个已导入的壁纸');
    if (!selection) {
      return;
    }
    const libraryDirectory = getWallpaperLibraryDirectory(context);
    const projectDirectory = managedWallpaperDirectory(libraryDirectory, selection.id);
    await loadConfiguredWallpaperProject(path.join(projectDirectory, 'wallpaper.json'));
    await selectManagedWallpaper(context, selection.id);
    const action = await vscode.window.showInformationMessage(
      `已选择壁纸“${selection.title}”。`,
      '应用并重启',
      '稍后'
    );
    if (action === '应用并重启') {
      await vscode.commands.executeCommand(COMMANDS.apply);
    }
  } catch (error) {
    showOperationError('选择已导入壁纸失败', error);
  }
}

export async function openWallpaperLibrary(context: vscode.ExtensionContext): Promise<void> {
  try {
    const libraryDirectory = getWallpaperLibraryDirectory(context);
    await ensureWallpaperLibrary(libraryDirectory);
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(libraryDirectory));
  } catch (error) {
    showOperationError('打开壁纸库失败', error);
  }
}

export async function exportImportedWallpaper(context: vscode.ExtensionContext): Promise<void> {
  try {
    const selection = await chooseManagedWallpaper(context, '选择要导出的壁纸');
    if (!selection) {
      return;
    }
    const selectedDestination = await vscode.window.showOpenDialog({
      title: '选择导出目标的父文件夹',
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false
    });
    if (!selectedDestination?.[0]) {
      return;
    }

    const libraryDirectory = getWallpaperLibraryDirectory(context);
    const sourceDirectory = managedWallpaperDirectory(libraryDirectory, selection.id);
    const destinationDirectory = path.join(
      path.resolve(selectedDestination[0].fsPath),
      selection.id
    );
    if (isSameOrInside(destinationDirectory, sourceDirectory)
      || isSameOrInside(sourceDirectory, destinationDirectory)) {
      throw new Error('导出目标不能位于原壁纸目录内部，也不能包含原壁纸目录。');
    }
    if (await pathExists(destinationDirectory)) {
      void vscode.window.showWarningMessage(
        `导出目标已存在：${destinationDirectory}。请选择其他父文件夹。`
      );
      return;
    }

    const stagingDirectory = path.join(
      path.dirname(destinationDirectory),
      `.${selection.id}.exporting-${process.pid}-${Date.now()}`
    );
    try {
      await fs.cp(sourceDirectory, stagingDirectory, {
        recursive: true,
        errorOnExist: true,
        force: false
      });
      await fs.rename(stagingDirectory, destinationDirectory);
    } finally {
      await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }

    const action = await vscode.window.showInformationMessage(
      `已导出“${selection.title}”到 ${destinationDirectory}。`,
      '打开文件夹'
    );
    if (action === '打开文件夹') {
      await vscode.commands.executeCommand(
        'revealFileInOS',
        vscode.Uri.file(destinationDirectory)
      );
    }
  } catch (error) {
    showOperationError('导出壁纸失败', error);
  }
}

export async function deleteImportedWallpaper(context: vscode.ExtensionContext): Promise<void> {
  try {
    const selection = await chooseManagedWallpaper(context, '选择要删除的已导入壁纸');
    if (!selection) {
      return;
    }
    const isActive = getActiveManagedWallpaperId(context) === selection.id;
    const confirmation = await vscode.window.showWarningMessage(
      isActive
        ? `“${selection.title}”是当前壁纸。删除受管副本并恢复 Workbench 吗？原 Wallpaper Engine 工程不会被删除。`
        : `删除壁纸库中的“${selection.title}”吗？原 Wallpaper Engine 工程不会被删除。`,
      { modal: true },
      '删除受管副本'
    );
    if (confirmation !== '删除受管副本') {
      return;
    }

    const libraryDirectory = getWallpaperLibraryDirectory(context);
    const projectDirectory = managedWallpaperDirectory(libraryDirectory, selection.id);
    if (isActive) {
      await removeWorkbenchPatch(vscode.env.appRoot);
      await context.globalState.update(STATE_KEYS.workbenchPatchEnabled, false);
      await clearProjectSelection(context);
    }
    await fs.rm(projectDirectory, { recursive: true, force: false });
    await removeManagedWallpaperFromCatalog(libraryDirectory, selection.id);
    void vscode.window.showInformationMessage(
      `已删除“${selection.title}”的受管副本。该副本无法恢复，但可从原工程重新导入。`
    );
  } catch (error) {
    showOperationError('删除已导入壁纸失败', error);
  }
}

async function chooseManagedWallpaper(
  context: vscode.ExtensionContext,
  placeHolder: string
): Promise<ManagedWallpaperEntry | undefined> {
  const libraryDirectory = getWallpaperLibraryDirectory(context);
  const wallpapers = await listExistingManagedWallpapers(libraryDirectory);
  if (wallpapers.length === 0) {
    void vscode.window.showInformationMessage('壁纸库中还没有已导入的壁纸。');
    return undefined;
  }
  const activeId = getActiveManagedWallpaperId(context);
  const items: WallpaperQuickPickItem[] = wallpapers.map(entry => ({
    label: entry.title,
    description: entry.id === activeId ? '当前壁纸' : entry.sourceType,
    detail: `来源：${entry.sourceDirectory}`,
    entry
  }));
  const selected = await vscode.window.showQuickPick(items, { placeHolder });
  return selected?.entry;
}

function isSameOrInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
