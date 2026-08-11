import * as path from 'node:path';
import * as vscode from 'vscode';
import { WALLPAPER_LIBRARY_DIRECTORY_NAME } from '../project/wallpaperLibrary';

export function getWallpaperLibraryDirectory(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, WALLPAPER_LIBRARY_DIRECTORY_NAME);
}
