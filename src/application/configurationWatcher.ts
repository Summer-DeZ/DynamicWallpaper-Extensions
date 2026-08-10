import * as vscode from 'vscode';
import { applyWallpaper } from './commands/projectCommands';
import { CONFIGURATION_SECTION, STATE_KEYS } from './constants';
import { getProjectDirectory } from './settings';

const RENDERER_SETTINGS = [
  `${CONFIGURATION_SECTION}.wallpaperOpacity`,
  `${CONFIGURATION_SECTION}.playbackRate`
] as const;

export function registerConfigurationWatcher(context: vscode.ExtensionContext): void {
  let timer: NodeJS.Timeout | undefined;

  const listener = vscode.workspace.onDidChangeConfiguration(event => {
    if (!RENDERER_SETTINGS.some(setting => event.affectsConfiguration(setting))) {
      return;
    }

    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      void applyRendererSettings(context);
    }, 400);
  });

  context.subscriptions.push(listener, {
    dispose: () => {
      if (timer) {
        clearTimeout(timer);
      }
    }
  });
}

async function applyRendererSettings(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(STATE_KEYS.workbenchPatchEnabled) === false) {
    return;
  }
  if (!getProjectDirectory(context)) {
    return;
  }

  await applyWallpaper(context, true);
}
