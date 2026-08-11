import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { decideWorkbenchPatchRecovery } from '../platform/workbench/patchLifecycle';
import {
  applyWorkbenchPatch,
  getWorkbenchPatchStatus,
  removeWorkbenchPatch
} from '../platform/workbench/workbenchPatch';
import { STATE_KEYS } from './constants';
import {
  clearProjectSelection,
  getActiveManagedWallpaperId,
  getProjectDirectory,
  loadConfiguredWallpaperProject,
  projectFileFor
} from './settings';

export async function refreshWorkbenchPatch(context: vscode.ExtensionContext): Promise<void> {
  const enabled = context.globalState.get<boolean>(STATE_KEYS.workbenchPatchEnabled);
  if (enabled === false) {
    return;
  }

  const projectDirectory = getProjectDirectory(context);
  if (!projectDirectory) {
    return;
  }

  try {
    const projectFile = projectFileFor(projectDirectory);
    if (!(await isFile(projectFile))) {
      await recoverMissingProject(context, projectFile);
      return;
    }

    const renderConfiguration = await loadConfiguredWallpaperProject(
      projectFile,
      context
    );
    const status = await getWorkbenchPatchStatus(vscode.env.appRoot, renderConfiguration);
    const recovery = decideWorkbenchPatchRecovery(enabled, status);
    if (recovery === 'none') {
      return;
    }
    if (recovery === 'remember-enabled') {
      await context.globalState.update(STATE_KEYS.workbenchPatchEnabled, true);
      return;
    }

    if (recovery === 'confirm-legacy-restore') {
      const choice = await vscode.window.showInformationMessage(
        '检测到动态壁纸注入已不存在，可能是 VS Code 更新所致。是否重新应用此前选择的壁纸工程？',
        '重新应用',
        '保持禁用'
      );
      if (choice === '保持禁用') {
        await context.globalState.update(STATE_KEYS.workbenchPatchEnabled, false);
        return;
      }
      if (choice !== '重新应用') {
        return;
      }
    }

    await applyWorkbenchPatch(vscode.env.appRoot, renderConfiguration);
    await context.globalState.update(STATE_KEYS.workbenchPatchEnabled, true);
    const restoredAfterUpdate = recovery === 'restore-missing'
      || recovery === 'confirm-legacy-restore';
    const action = await vscode.window.showInformationMessage(
      restoredAfterUpdate
        ? '检测到 VS Code 更新移除了动态壁纸注入，现已自动恢复。'
        : '检测到 Dynamic Wallpaper Renderer 已更新，旧壁纸注入已自动迁移。',
      '立即重启'
    );
    if (action === '立即重启') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showWarningMessage(
      `Dynamic Wallpaper Renderer 无法自动更新现有注入：${message}`
    );
  }
}

async function recoverMissingProject(
  context: vscode.ExtensionContext,
  projectFile: string
): Promise<void> {
  const managedWallpaperId = getActiveManagedWallpaperId(context);

  // Selection state lives in VS Code's global state, independently from globalStorage.
  // If the managed library is deleted manually, retaining this ID would make every
  // subsequent startup try to open the same path and emit ENOENT again.
  await clearProjectSelection(context);
  await context.globalState.update(STATE_KEYS.workbenchPatchEnabled, false);

  try {
    await removeWorkbenchPatch(vscode.env.appRoot);
    const action = await vscode.window.showWarningMessage(
      managedWallpaperId
        ? `当前壁纸“${managedWallpaperId}”的受管文件已不存在，已清除失效选择并恢复 Workbench。`
        : `当前壁纸工程已不存在，已清除失效选择并恢复 Workbench：${projectFile}`,
      '立即重启'
    );
    if (action === '立即重启') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showWarningMessage(
      `当前壁纸工程已不存在，失效选择已清除；但 Workbench 残留注入清理失败：${message}`
    );
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
