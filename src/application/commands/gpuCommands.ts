import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  findCodeExecutable,
  preferHighPerformanceGpu,
  readGpuPreference,
  restoreGpuPreference
} from '../../platform/windows/gpuPreference';
import { STATE_KEYS } from '../constants';
import { showOperationError } from '../errors';

export async function configureHighPerformanceGpu(
  context: vscode.ExtensionContext
): Promise<void> {
  try {
    await setHighPerformanceGpu(context, true);
  } catch (error) {
    showOperationError('设置高性能 GPU 失败', error);
  }
}

export async function setHighPerformanceGpu(
  context: vscode.ExtensionContext,
  showConfirmation: boolean
): Promise<void> {
  const codeExecutable = await findCodeExecutable(vscode.env.appRoot);
  const storedExecutable = context.globalState.get<string>(STATE_KEYS.gpuExecutable);
  if (!storedExecutable) {
    const previousValue = await readGpuPreference(codeExecutable);
    if (previousValue !== undefined) {
      await context.globalState.update(STATE_KEYS.gpuPreviousValue, previousValue);
    }
    await context.globalState.update(STATE_KEYS.gpuExecutable, codeExecutable);
  }

  await preferHighPerformanceGpu(codeExecutable);
  if (showConfirmation) {
    void vscode.window.showInformationMessage(
      `已将 ${path.basename(codeExecutable)} 设置为 Windows 高性能 GPU 应用；重启 VS Code 后生效。`
    );
  }
}

export async function configureSystemGpuPreference(
  context: vscode.ExtensionContext
): Promise<void> {
  try {
    const storedExecutable = context.globalState.get<string>(STATE_KEYS.gpuExecutable);
    const codeExecutable = storedExecutable ?? await findCodeExecutable(vscode.env.appRoot);
    const previousValue = context.globalState.get<string>(STATE_KEYS.gpuPreviousValue);
    await restoreGpuPreference(codeExecutable, previousValue);
    await context.globalState.update(STATE_KEYS.gpuPreviousValue, undefined);
    await context.globalState.update(STATE_KEYS.gpuExecutable, undefined);
    void vscode.window.showInformationMessage('已恢复 VS Code 原有的 Windows GPU 首选项。');
  } catch (error) {
    showOperationError('恢复 GPU 首选项失败', error);
  }
}
