import * as vscode from 'vscode';
import { resolveWallpaperLibraryDirectory } from '../project/wallpaperLibrary';
import { CONFIGURATION_SECTION } from './constants';

export function getWallpaperLibraryDirectory(context: vscode.ExtensionContext): string {
  const configuredDirectory = vscode.workspace
    .getConfiguration(CONFIGURATION_SECTION)
    .get<string>('libraryDirectory', '');
  return resolveWallpaperLibraryDirectory(context.globalStorageUri.fsPath, configuredDirectory);
}
