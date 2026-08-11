import * as vscode from 'vscode';
import { applyWallpaper } from './commands/projectCommands';
import { CONFIGURATION_SECTION, STATE_KEYS } from './constants';
import { getProjectDirectory } from './settings';

const RENDERER_SETTINGS = [
  `${CONFIGURATION_SECTION}.wallpaperOpacity`,
  `${CONFIGURATION_SECTION}.playbackRate`,
  `${CONFIGURATION_SECTION}.maxFps`,
  `${CONFIGURATION_SECTION}.pauseWhenUnfocused`,
  `${CONFIGURATION_SECTION}.opaqueEditorFileTypes`
] as const;

let promptVisible = false;

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
      void offerToApplyRendererSettings(context);
    }, 600);
  });

  context.subscriptions.push(listener, {
    dispose: () => {
      if (timer) {
        clearTimeout(timer);
      }
    }
  });
}

async function offerToApplyRendererSettings(context: vscode.ExtensionContext): Promise<void> {
  if (promptVisible) {
    return;
  }
  if (context.globalState.get<boolean>(STATE_KEYS.workbenchPatchEnabled) === false) {
    return;
  }
  if (!getProjectDirectory(context)) {
    return;
  }

  promptVisible = true;
  try {
    const action = await vscode.window.showInformationMessage(
      '动态壁纸设置已更改，需要重新应用并重载 VS Code 窗口后生效。',
      '应用并重启',
      '稍后'
    );
    if (action === '应用并重启') {
      await applyWallpaper(context, true);
    }
  } finally {
    promptVisible = false;
  }
}
