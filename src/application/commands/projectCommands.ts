import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createStarterProject } from '../../project/starterProject';
import { isFile } from '../../platform/filesystem';
import {
  applyWorkbenchPatch,
  removeWorkbenchPatch
} from '../../platform/workbench/workbenchPatch';
import { COMMANDS, CONFIGURATION_SECTION, PROJECT_FILE_NAME, STATE_KEYS } from '../constants';
import { showOperationError } from '../errors';
import {
  getProjectDirectory,
  loadConfiguredWallpaperProject,
  projectFileFor,
  selectExternalProject
} from '../settings';
import { setHighPerformanceGpu } from './gpuCommands';

export async function selectProjectFolder(context: vscode.ExtensionContext): Promise<void> {
  const selected = await vscode.window.showOpenDialog({
    title: `选择包含 ${PROJECT_FILE_NAME} 的壁纸文件夹`,
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false
  });
  if (!selected?.[0]) {
    return;
  }

  const projectDirectory = selected[0].fsPath;
  const projectFile = projectFileFor(projectDirectory);
  if (!(await isFile(projectFile))) {
    const action = await vscode.window.showWarningMessage(
      `该文件夹中没有 ${PROJECT_FILE_NAME}。`,
      '创建示例工程',
      '取消'
    );
    if (action === '创建示例工程') {
      await writeStarterProject(context, projectDirectory);
    }
    return;
  }

  try {
    await loadConfiguredWallpaperProject(projectFile);
  } catch (error) {
    showOperationError('壁纸工程配置无效', error);
    return;
  }
  await saveProjectDirectoryAndOfferApply(context, projectDirectory);
}

export async function createProjectFolder(context: vscode.ExtensionContext): Promise<void> {
  const selected = await vscode.window.showOpenDialog({
    title: '选择用于创建壁纸工程的文件夹',
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false
  });
  if (selected?.[0]) {
    await writeStarterProject(context, selected[0].fsPath);
  }
}

export async function applyWallpaper(
  context: vscode.ExtensionContext,
  reloadAutomatically = false
): Promise<void> {
  try {
    const projectDirectory = getProjectDirectory(context);
    if (!projectDirectory) {
      throw new Error('尚未选择壁纸文件夹。请先运行“选择壁纸文件夹”。');
    }

    const renderConfiguration = await loadConfiguredWallpaperProject(
      projectFileFor(projectDirectory)
    );
    await applyWorkbenchPatch(vscode.env.appRoot, renderConfiguration);
    await context.globalState.update(STATE_KEYS.workbenchPatchEnabled, true);

    const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    let gpuWarning = '';
    if (configuration.get<boolean>('preferHighPerformanceGpu', true)) {
      try {
        await setHighPerformanceGpu(context, false);
      } catch (error) {
        gpuWarning = ` 高性能 GPU 设置未成功：${error instanceof Error ? error.message : String(error)}`;
      }
    }

    if (reloadAutomatically) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
      return;
    }

    const action = await vscode.window.showInformationMessage(
      `壁纸工程已应用。VS Code 重启后生效。${gpuWarning}`,
      '立即重启'
    );
    if (action === '立即重启') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } catch (error) {
    showOperationError('应用动态壁纸失败', error);
  }
}

export async function restoreWorkbench(context: vscode.ExtensionContext): Promise<void> {
  try {
    await removeWorkbenchPatch(vscode.env.appRoot);
    await context.globalState.update(STATE_KEYS.workbenchPatchEnabled, false);
    const action = await vscode.window.showInformationMessage(
      '已移除 Dynamic Wallpaper Renderer 注入，其他背景插件的内容未改动。',
      '立即重启'
    );
    if (action === '立即重启') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } catch (error) {
    showOperationError('恢复 Workbench 失败', error);
  }
}

async function writeStarterProject(
  context: vscode.ExtensionContext,
  projectDirectory: string
): Promise<void> {
  const projectFile = projectFileFor(projectDirectory);
  if (await isFile(projectFile)) {
    const confirmation = await vscode.window.showWarningMessage(
      `${PROJECT_FILE_NAME} 已存在，是否覆盖？`,
      { modal: true },
      '覆盖'
    );
    if (confirmation !== '覆盖') {
      return;
    }
  }

  try {
    await fs.writeFile(projectFile, createStarterProject(), 'utf8');
    await selectExternalProject(context, projectDirectory);
    const document = await vscode.workspace.openTextDocument(projectFile);
    await vscode.window.showTextDocument(document);
    void vscode.window.showInformationMessage(
      `已创建 ${PROJECT_FILE_NAME}。编辑效果后运行“应用并重启”。`
    );
  } catch (error) {
    showOperationError('创建壁纸工程失败', error);
  }
}

async function saveProjectDirectoryAndOfferApply(
  context: vscode.ExtensionContext,
  projectDirectory: string
): Promise<void> {
  await selectExternalProject(context, projectDirectory);
  const action = await vscode.window.showInformationMessage(
    `已选择壁纸文件夹：${path.basename(projectDirectory)}`,
    '应用并重启',
    '稍后'
  );
  if (action === '应用并重启') {
    await vscode.commands.executeCommand(COMMANDS.apply);
  }
}
