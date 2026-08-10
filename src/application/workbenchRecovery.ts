import * as vscode from 'vscode';
import { decideWorkbenchPatchRecovery } from '../platform/workbench/patchLifecycle';
import {
  applyWorkbenchPatch,
  getWorkbenchPatchStatus
} from '../platform/workbench/workbenchPatch';
import { STATE_KEYS } from './constants';
import {
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
    const renderConfiguration = await loadConfiguredWallpaperProject(
      projectFileFor(projectDirectory)
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
