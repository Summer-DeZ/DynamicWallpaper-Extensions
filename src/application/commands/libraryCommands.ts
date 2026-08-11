import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { pathExists } from '../../platform/filesystem';
import { importWallpaperEngineProject } from '../../importers/wallpaperEngineImporter';
import { relocateRuntimeProject } from '../../project/relocateRuntimeProject';
import { removeWorkbenchPatch } from '../../platform/workbench/workbenchPatch';
import {
  ensureWallpaperLibrary,
  listExistingManagedWallpapers,
  ManagedWallpaperEntry,
  managedWallpaperDirectory,
  removeManagedWallpaperFromCatalog,
  upsertManagedWallpaper
} from '../../project/wallpaperLibrary';
import { COMMANDS, STATE_KEYS } from '../constants';
import { showOperationError } from '../errors';
import { getWallpaperLibraryDirectory } from '../libraryStorage';
import {
  clearProjectSelection,
  getActiveManagedWallpaperId,
  getProjectDirectory,
  loadConfiguredWallpaperProject,
  selectExternalProject,
  selectManagedWallpaper
} from '../settings';
import { applyWallpaper } from './projectCommands';

interface WallpaperQuickPickItem extends vscode.QuickPickItem {
  entry: ManagedWallpaperEntry;
}

export async function selectImportedWallpaper(
  context: vscode.ExtensionContext,
  wallpaperId?: string
): Promise<void> {
  try {
    const selection = await chooseManagedWallpaper(
      context,
      '选择后将立即应用壁纸并重载窗口',
      wallpaperId
    );
    if (!selection) {
      return;
    }
    const libraryDirectory = getWallpaperLibraryDirectory(context);
    const projectDirectory = managedWallpaperDirectory(libraryDirectory, selection.id);
    await upgradeLegacyImportedWallpaper(context, libraryDirectory, projectDirectory, selection);
    await loadConfiguredWallpaperProject(path.join(projectDirectory, 'wallpaper.json'));

    const previousManagedWallpaperId = getActiveManagedWallpaperId(context);
    const previousProjectDirectory = previousManagedWallpaperId
      ? ''
      : getProjectDirectory(context);
    await selectManagedWallpaper(context, selection.id);
    const applied = await applyWallpaper(context, true);
    if (!applied) {
      await restoreProjectSelection(
        context,
        previousManagedWallpaperId,
        previousProjectDirectory
      );
    }
  } catch (error) {
    showOperationError('选择已导入壁纸失败', error);
  }
}

async function upgradeLegacyImportedWallpaper(
  context: vscode.ExtensionContext,
  libraryDirectory: string,
  projectDirectory: string,
  entry: ManagedWallpaperEntry
): Promise<void> {
  const projectFile = path.join(projectDirectory, 'wallpaper.json');
  const raw = JSON.parse(await fs.readFile(projectFile, 'utf8')) as { version?: number };
  if (raw.version === 2 || !(await pathExists(path.join(entry.sourceDirectory, 'project.json')))) return;
  const result = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `正在将“${entry.title}”无损迁移到 WebGL2 运行时`,
    cancellable: false
  }, progress => importWallpaperEngineProject({
    sourceDirectory: entry.sourceDirectory,
    outputDirectory: projectDirectory,
    extensionPath: context.extensionPath,
    overwrite: true,
    onProgress: update => progress.report({ message: update.message, increment: update.increment })
  }));
  await upsertManagedWallpaper(libraryDirectory, {
    id: entry.id,
    title: result.title,
    sourceType: result.sourceType,
    sourceDirectory: result.sourceDirectory,
    runtimeFormatVersion: 1,
    sourceVersion: entry.sourceVersion,
    compatibilityStatus: result.warnings.length ? 'partial' : 'compatible',
    networkHosts: entry.networkHosts
  });
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
      await relocateRuntimeProject(
        stagingDirectory,
        sourceDirectory,
        destinationDirectory
      );
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
  placeHolder: string,
  wallpaperId?: string
): Promise<ManagedWallpaperEntry | undefined> {
  const libraryDirectory = getWallpaperLibraryDirectory(context);
  const wallpapers = await listExistingManagedWallpapers(libraryDirectory);
  if (wallpapers.length === 0) {
    const action = await vscode.window.showInformationMessage(
      '壁纸库中还没有已导入的壁纸。',
      '导入 Wallpaper Engine 工程'
    );
    if (action === '导入 Wallpaper Engine 工程') {
      await vscode.commands.executeCommand(COMMANDS.importWallpaperEngine);
    }
    return undefined;
  }

  if (wallpaperId) {
    const requested = wallpapers.find(entry => entry.id === wallpaperId);
    if (!requested) {
      throw new Error(`壁纸库中找不到项目：${wallpaperId}`);
    }
    return requested;
  }

  const activeId = getActiveManagedWallpaperId(context);
  const orderedWallpapers = [...wallpapers].sort((left, right) => {
    const activeOrder = Number(right.id === activeId) - Number(left.id === activeId);
    return activeOrder || left.title.localeCompare(right.title, 'zh-CN');
  });
  const items: WallpaperQuickPickItem[] = orderedWallpapers.map(entry => ({
    label: entry.id === activeId ? `$(check) ${entry.title}` : entry.title,
    description: [
      'Wallpaper Engine',
      sourceTypeLabel(entry.sourceType),
      compatibilityLabel(entry.compatibilityStatus),
      entry.id === activeId ? '当前壁纸' : undefined
    ].filter((value): value is string => Boolean(value)).join(' · '),
    detail: `ID：${entry.id} · 来源：${entry.sourceDirectory}`,
    entry
  }));
  const selected = await vscode.window.showQuickPick(items, {
    title: '浏览并切换壁纸库',
    placeHolder,
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true
  });
  return selected?.entry;
}

async function restoreProjectSelection(
  context: vscode.ExtensionContext,
  managedWallpaperId: string | undefined,
  externalProjectDirectory: string
): Promise<void> {
  if (managedWallpaperId) {
    await selectManagedWallpaper(context, managedWallpaperId);
  } else if (externalProjectDirectory) {
    await selectExternalProject(context, externalProjectDirectory);
  } else {
    await clearProjectSelection(context);
  }
}

function sourceTypeLabel(sourceType: ManagedWallpaperEntry['sourceType']): string {
  switch (sourceType) {
    case 'Scene': return '场景';
    case 'Web': return '网页';
    case 'Video': return '视频';
  }
}

function compatibilityLabel(
  status: ManagedWallpaperEntry['compatibilityStatus']
): string {
  switch (status) {
    case 'compatible': return '完全兼容';
    case 'partial': return '部分兼容';
    case 'incompatible': return '不兼容';
    case 'legacy': return '待升级';
  }
}

function isSameOrInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
