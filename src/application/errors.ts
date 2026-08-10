import * as vscode from 'vscode';

export function showOperationError(prefix: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const permissionHint = /EACCES|EPERM|permission|access.*denied/i.test(message)
    ? ' 请以管理员身份启动 VS Code 后重试。'
    : '';
  void vscode.window.showErrorMessage(`${prefix}：${message}${permissionHint}`);
}
