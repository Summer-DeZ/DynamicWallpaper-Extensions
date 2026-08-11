import * as path from 'node:path';
import * as vscode from 'vscode';
import { WALLPAPER_LIBRARY_DIRECTORY_NAME } from '../project/wallpaperLibrary';
import { STATE_KEYS } from './constants';

export function getWallpaperLibraryDirectory(context: vscode.ExtensionContext): string {
  const preservedDirectory = context.globalState
    .get<string>(STATE_KEYS.wallpaperLibraryDirectory, '')
    .trim();
  if (preservedDirectory) return path.resolve(preservedDirectory);
  return path.join(context.globalStorageUri.fsPath, WALLPAPER_LIBRARY_DIRECTORY_NAME);
}
