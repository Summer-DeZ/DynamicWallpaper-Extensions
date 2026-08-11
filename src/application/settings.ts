import * as path from 'node:path';
import * as vscode from 'vscode';
import { RendererConfiguration } from '../domain/renderer';
import { loadWallpaperProject } from '../project/wallpaperProject';
import { managedWallpaperDirectory } from '../project/wallpaperLibrary';
import { CONFIGURATION_SECTION, PROJECT_FILE_NAME, STATE_KEYS } from './constants';
import { getWallpaperLibraryDirectory } from './libraryStorage';
import { prepareRuntimeStateBridge } from './runtimeState';

type ProjectSelection =
  | { kind: 'none' }
  | { kind: 'managed'; id: string }
  | { kind: 'external'; directory: string };

export function getProjectDirectory(context: vscode.ExtensionContext): string {
  const selection = getProjectSelection(context);
  if (selection.kind === 'managed') {
    return managedWallpaperDirectory(
      getWallpaperLibraryDirectory(context),
      selection.id
    );
  }
  return selection.kind === 'external' ? selection.directory : '';
}

export function projectFileFor(projectDirectory: string): string {
  return path.join(projectDirectory, PROJECT_FILE_NAME);
}

export function getActiveManagedWallpaperId(
  context: vscode.ExtensionContext
): string | undefined {
  const selection = getProjectSelection(context);
  return selection.kind === 'managed' ? selection.id : undefined;
}

export async function selectExternalProject(
  context: vscode.ExtensionContext,
  projectDirectory: string
): Promise<void> {
  await context.globalState.update(STATE_KEYS.projectSelection, {
    kind: 'external',
    directory: path.resolve(projectDirectory)
  } satisfies ProjectSelection);
}

export async function selectManagedWallpaper(
  context: vscode.ExtensionContext,
  wallpaperId: string
): Promise<void> {
  await context.globalState.update(STATE_KEYS.projectSelection, {
    kind: 'managed',
    id: wallpaperId
  } satisfies ProjectSelection);
}

export async function clearProjectSelection(context: vscode.ExtensionContext): Promise<void> {
  // Persist an explicit empty state so stale legacy keys cannot become active
  // again after the new atomic key is cleared.
  await context.globalState.update(STATE_KEYS.projectSelection, {
    kind: 'none'
  } satisfies ProjectSelection);
}

export async function loadConfiguredWallpaperProject(
  projectFile: string,
  context?: vscode.ExtensionContext
): Promise<RendererConfiguration> {
  const settings = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  const project = await loadWallpaperProject(projectFile);
  const wallpaperOpacity = optionalNumber(
    settings.get<number | null>('wallpaperOpacity', null)
  );
  const playbackRate = optionalNumber(
    settings.get<number | null>('playbackRate', null)
  );
  const maxFps = optionalNumber(
    settings.get<number | null>('maxFps', null)
  );
  const opaqueEditorFileTypes = normalizeFileTypes(
    settings.get<string[]>('opaqueEditorFileTypes', [])
  );
  const pauseWhenUnfocused = settings.get<boolean>('pauseWhenUnfocused', true);

  const runtimeState = context
    ? await prepareRuntimeStateBridge(context, projectFile)
    : undefined;
  return {
    ...project,
    runtime: runtimeState ? {
      ...project.runtime,
      stateUri: runtimeState.uri,
      networkHosts: runtimeState.state.networkHosts,
      userProperties: runtimeState.state.userProperties
    } : project.runtime,
    surfaceOpacity: wallpaperOpacity !== undefined
      ? 1 - clamp(wallpaperOpacity, 0, 1)
      : project.surfaceOpacity,
    pauseWhenUnfocused,
    opaqueEditorFileTypes,
    performance: maxFps !== undefined
      ? { ...project.performance, maxFps: Math.round(clamp(maxFps, 15, 60)) }
      : project.performance,
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

  const legacyManagedId = context.globalState
      .get<string>(STATE_KEYS.activeManagedWallpaperId, '')
      .trim();
  const legacyExternalDirectory = context.globalState
      .get<string>(STATE_KEYS.externalProjectDirectory, '')
      .trim();
  if (!readAtomicProjectSelection(context)) {
    const legacyConfiguredDirectory = settings
      .inspect<string>('projectDirectory')?.globalValue?.trim();
    const selection: ProjectSelection = legacyManagedId
      ? { kind: 'managed', id: legacyManagedId }
      : legacyExternalDirectory || legacyConfiguredDirectory
        ? { kind: 'external', directory: path.resolve(legacyExternalDirectory || legacyConfiguredDirectory!) }
        : { kind: 'none' };
    await context.globalState.update(STATE_KEYS.projectSelection, selection);
  }

  // Versions 0.6/0.7 allowed a custom managed-library directory.  Preserve
  // that location before retiring the setting; otherwise every imported
  // wallpaper appears to vanish after upgrading.
  const legacyLibraryDirectory = settings.inspect<string>('libraryDirectory')?.globalValue?.trim();
  if (legacyLibraryDirectory
    && !context.globalState.get<string>(STATE_KEYS.wallpaperLibraryDirectory, '').trim()) {
    await context.globalState.update(
      STATE_KEYS.wallpaperLibraryDirectory,
      path.resolve(legacyLibraryDirectory)
    );
  }

  // The atomic state is authoritative from here on.  Legacy cleanup is safe
  // even if it is interrupted because no selection uses the two old keys.
  if (legacyManagedId) {
    await context.globalState.update(STATE_KEYS.activeManagedWallpaperId, undefined)
      .then(undefined, () => undefined);
  }
  if (legacyExternalDirectory) {
    await context.globalState.update(STATE_KEYS.externalProjectDirectory, undefined)
      .then(undefined, () => undefined);
  }
  if (settings.inspect<string>('projectDirectory')?.globalValue !== undefined) {
    await settings.update(
      'projectDirectory',
      undefined,
      vscode.ConfigurationTarget.Global
    ).then(undefined, () => undefined);
  }
  if (legacyLibraryDirectory) {
    await settings.update(
      'libraryDirectory',
      undefined,
      vscode.ConfigurationTarget.Global
    ).then(undefined, () => undefined);
  }
}

function getProjectSelection(context: vscode.ExtensionContext): ProjectSelection {
  return readAtomicProjectSelection(context) ?? readLegacyProjectSelection(context);
}

function readAtomicProjectSelection(context: vscode.ExtensionContext): ProjectSelection | undefined {
  const value = context.globalState.get<unknown>(STATE_KEYS.projectSelection);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const selection = value as Record<string, unknown>;
  if (selection.kind === 'none') return { kind: 'none' };
  if (selection.kind === 'managed' && typeof selection.id === 'string' && selection.id.trim()) {
    return { kind: 'managed', id: selection.id.trim() };
  }
  if (selection.kind === 'external'
    && typeof selection.directory === 'string'
    && selection.directory.trim()) {
    return { kind: 'external', directory: path.resolve(selection.directory) };
  }
  return undefined;
}

function readLegacyProjectSelection(context: vscode.ExtensionContext): ProjectSelection {
  const managedId = context.globalState
    .get<string>(STATE_KEYS.activeManagedWallpaperId, '')
    .trim();
  if (managedId) return { kind: 'managed', id: managedId };
  const directory = context.globalState
    .get<string>(STATE_KEYS.externalProjectDirectory, '')
    .trim();
  return directory
    ? { kind: 'external', directory: path.resolve(directory) }
    : { kind: 'none' };
}

function optionalNumber(value: number | null): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeFileTypes(values: string[]): string[] {
  return [...new Set(values
    .map(value => value.trim().toLowerCase().replace(/^\*?\./, ''))
    .filter(value => /^[a-z0-9][a-z0-9+_-]*$/.test(value))
  )];
}
