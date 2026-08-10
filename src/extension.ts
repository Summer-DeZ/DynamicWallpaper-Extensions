import * as vscode from 'vscode';
import { registerCommands } from './application/registerCommands';
import { refreshWorkbenchPatch } from './application/workbenchRecovery';

export function activate(context: vscode.ExtensionContext): void {
  registerCommands(context);
  void refreshWorkbenchPatch(context);
}

export function deactivate(): void {
  // The Workbench patch must remain active after the extension host shuts down.
}
