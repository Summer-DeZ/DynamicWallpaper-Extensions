import * as vscode from 'vscode';
import { registerConfigurationWatcher } from './application/configurationWatcher';
import { registerCommands } from './application/registerCommands';
import { migrateLegacySettings } from './application/settings';
import { refreshWorkbenchPatch } from './application/workbenchRecovery';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  registerCommands(context);
  await migrateLegacySettings();
  registerConfigurationWatcher(context);
  void refreshWorkbenchPatch(context);
}

export function deactivate(): void {
  // The Workbench patch must remain active after the extension host shuts down.
}
