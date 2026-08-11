import * as path from 'node:path';
import * as vscode from 'vscode';
import { RendererConfiguration } from '../domain/renderer';
import { loadWallpaperProject } from '../project/wallpaperProject';
import { managedWallpaperDirectory } from '../project/wallpaperLibrary';
import { CONFIGURATION_SECTION, PROJECT_FILE_NAME, STATE_KEYS } from './constants';
import { getWallpaperLibraryDirectory } from './libraryStorage';

export function getProjectDirectory(context: vscode.ExtensionContext): string {
  const managedWallpaperId = getActiveManagedWallpaperId(context);
  if (managedWallpaperId) {
    return managedWallpaperDirectory(
      getWallpaperLibraryDirectory(context),
      managedWallpaperId
    );
  }
  return context.globalState.get<string>(STATE_KEYS.externalProjectDirectory, '').trim();
}

export function projectFileFor(projectDirectory: string): string {
  return path.join(projectDirectory, PROJECT_FILE_NAME);
}

export function getActiveManagedWallpaperId(
  context: vscode.ExtensionContext
): string | undefined {
  return context.globalState.get<string>(STATE_KEYS.activeManagedWallpaperId);
}

export async function selectExternalProject(
  context: vscode.ExtensionContext,
  projectDirectory: string
): Promise<void> {
  await context.globalState.update(STATE_KEYS.externalProjectDirectory, projectDirectory);
  await context.globalState.update(STATE_KEYS.activeManagedWallpaperId, undefined);
}

export async function selectManagedWallpaper(
  context: vscode.ExtensionContext,
  wallpaperId: string
): Promise<void> {
  await context.globalState.update(STATE_KEYS.activeManagedWallpaperId, wallpaperId);
  await context.globalState.update(STATE_KEYS.externalProjectDirectory, undefined);
}

export async function clearProjectSelection(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(STATE_KEYS.activeManagedWallpaperId, undefined);
  await context.globalState.update(STATE_KEYS.externalProjectDirectory, undefined);
}

export async function loadConfiguredWallpaperProject(
  projectFile: string
): Promise<RendererConfiguration> {
  const settings = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  const project = await loadWallpaperProject(projectFile);
  const wallpaperOpacity = optionalNumber(
    settings.get<number | null>('wallpaperOpacity', null)
  );
  const playbackRate = optionalNumber(
    settings.get<number | null>('playbackRate', null)
  );

  return {
    ...project,
    surfaceOpacity: wallpaperOpacity !== undefined
      ? 1 - clamp(wallpaperOpacity, 0, 1)
      : project.surfaceOpacity,
    layers: playbackRate !== undefined
      ? project.layers.map(layer => layer.type === 'video'
        ? { ...layer, playbackRate: clamp(playbackRate, 0.25, 4) }
        : layer)
      : project.layers
  };
}

export async function migrateLegacySettings(context: vscode.ExtensionContext): Promise<void> {
  const settings = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  const currentOpacity = settings.inspect<number | null>('wallpaperOpacity');
  const legacyOpacity = settings.inspect<number>('opacity');
  const hasCurrentOpacity = currentOpacity?.globalValue !== undefined;

  if (!hasCurrentOpacity && legacyOpacity?.globalValue !== undefined) {
    await settings.update(
      'wallpaperOpacity',
      clamp(legacyOpacity.globalValue, 0, 1),
      vscode.ConfigurationTarget.Global
    );
  }
  if (legacyOpacity?.globalValue !== undefined) {
    await settings.update('opacity', undefined, vscode.ConfigurationTarget.Global);
  }

  const legacyProjectDirectory = settings.inspect<string>('projectDirectory')?.globalValue?.trim();
  if (legacyProjectDirectory
    && !context.globalState.get<string>(STATE_KEYS.externalProjectDirectory)
    && !getActiveManagedWallpaperId(context)) {
    await context.globalState.update(
      STATE_KEYS.externalProjectDirectory,
      legacyProjectDirectory
    );
  }
  await settings.update(
    'projectDirectory',
    undefined,
    vscode.ConfigurationTarget.Global
  ).then(undefined, () => undefined);
  await settings.update(
    'libraryDirectory',
    undefined,
    vscode.ConfigurationTarget.Global
  ).then(undefined, () => undefined);
}

function optionalNumber(value: number | null): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
