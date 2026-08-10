import * as vscode from 'vscode';
import { COMMANDS } from './constants';
import {
  configureHighPerformanceGpu,
  configureSystemGpuPreference
} from './commands/gpuCommands';
import {
  applyWallpaper,
  createProjectFolder,
  restoreWorkbench,
  selectProjectFolder
} from './commands/projectCommands';
import { importWallpaperEngine } from './commands/wallpaperEngineImportCommand';
import {
  deleteImportedWallpaper,
  exportImportedWallpaper,
  openWallpaperLibrary,
  selectImportedWallpaper
} from './commands/libraryCommands';

export function registerCommands(context: vscode.ExtensionContext): void {
  const importOutput = vscode.window.createOutputChannel('Dynamic Wallpaper Import');
  context.subscriptions.push(
    importOutput,
    vscode.commands.registerCommand(COMMANDS.selectFolder, () => selectProjectFolder(context)),
    vscode.commands.registerCommand(COMMANDS.createProject, () => createProjectFolder(context)),
    vscode.commands.registerCommand(
      COMMANDS.importWallpaperEngine,
      () => importWallpaperEngine(context, importOutput)
    ),
    vscode.commands.registerCommand(
      COMMANDS.selectImportedWallpaper,
      () => selectImportedWallpaper(context)
    ),
    vscode.commands.registerCommand(
      COMMANDS.openWallpaperLibrary,
      () => openWallpaperLibrary(context)
    ),
    vscode.commands.registerCommand(
      COMMANDS.exportImportedWallpaper,
      () => exportImportedWallpaper(context)
    ),
    vscode.commands.registerCommand(
      COMMANDS.deleteImportedWallpaper,
      () => deleteImportedWallpaper(context)
    ),
    vscode.commands.registerCommand(COMMANDS.apply, () => applyWallpaper(context)),
    vscode.commands.registerCommand(COMMANDS.restore, () => restoreWorkbench(context)),
    vscode.commands.registerCommand(
      COMMANDS.preferHighPerformanceGpu,
      () => configureHighPerformanceGpu(context)
    ),
    vscode.commands.registerCommand(
      COMMANDS.useSystemGpuPreference,
      () => configureSystemGpuPreference(context)
    )
  );
}
