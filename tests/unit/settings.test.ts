import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => {
  const inspected = new Map<string, unknown>();
  const configurationUpdates: Array<{ key: string; value: unknown }> = [];
  return {
    inspected,
    configurationUpdates,
    workspace: {
      getConfiguration: () => ({
        get: <T>(_key: string, fallback: T): T => fallback,
        inspect: <T>(key: string): { globalValue?: T } | undefined => inspected.has(key)
          ? { globalValue: inspected.get(key) as T }
          : undefined,
        update: async (key: string, value: unknown): Promise<void> => {
          configurationUpdates.push({ key, value });
          if (value === undefined) inspected.delete(key);
          else inspected.set(key, value);
        }
      })
    },
    ConfigurationTarget: { Global: 1 }
  };
});

vi.mock('vscode', () => vscodeMock);

import { STATE_KEYS } from '../../src/application/constants';
import { getWallpaperLibraryDirectory } from '../../src/application/libraryStorage';
import {
  clearProjectSelection,
  getActiveManagedWallpaperId,
  getProjectDirectory,
  migrateLegacySettings,
  selectExternalProject,
  selectManagedWallpaper
} from '../../src/application/settings';

beforeEach(() => {
  vscodeMock.inspected.clear();
  vscodeMock.configurationUpdates.length = 0;
});

describe('atomic project selection', () => {
  it('never produces a mixed or empty selection when commands overlap', async () => {
    const externalDirectory = path.resolve('D:\\wallpapers\\external');
    const context = createContext({}, async (_key, value) => {
      if ((value as { kind?: string } | undefined)?.kind === 'external') {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    });

    await Promise.all([
      selectExternalProject(context, externalDirectory),
      selectManagedWallpaper(context, 'managed-1')
    ]);

    const persisted = context.values.get(STATE_KEYS.projectSelection) as { kind: string };
    expect(['external', 'managed']).toContain(persisted.kind);
    if (persisted.kind === 'managed') {
      expect(getActiveManagedWallpaperId(context)).toBe('managed-1');
      expect(getProjectDirectory(context)).toContain('managed-1');
    } else {
      expect(getActiveManagedWallpaperId(context)).toBeUndefined();
      expect(getProjectDirectory(context)).toBe(externalDirectory);
    }
  });

  it('persists an explicit empty state instead of reviving legacy keys', async () => {
    const context = createContext({
      [STATE_KEYS.activeManagedWallpaperId]: 'legacy-managed'
    });
    await clearProjectSelection(context);
    expect(getActiveManagedWallpaperId(context)).toBeUndefined();
    expect(getProjectDirectory(context)).toBe('');
  });
});

describe('legacy settings migration', () => {
  it('atomically migrates selection and preserves a custom library directory', async () => {
    const customLibrary = path.resolve('D:', 'old-custom-wallpapers');
    vscodeMock.inspected.set('libraryDirectory', customLibrary);
    const context = createContext({
      [STATE_KEYS.activeManagedWallpaperId]: 'workshop-42'
    });

    await migrateLegacySettings(context);

    expect(context.values.get(STATE_KEYS.projectSelection)).toEqual({
      kind: 'managed', id: 'workshop-42'
    });
    expect(context.values.get(STATE_KEYS.wallpaperLibraryDirectory)).toBe(customLibrary);
    expect(getWallpaperLibraryDirectory(context)).toBe(customLibrary);
    expect(vscodeMock.inspected.has('libraryDirectory')).toBe(false);
  });

  it('does not clear the custom-directory setting when persistence fails', async () => {
    const customLibrary = path.resolve('D:', 'old-custom-wallpapers');
    vscodeMock.inspected.set('libraryDirectory', customLibrary);
    const context = createContext({}, async key => {
      if (key === STATE_KEYS.wallpaperLibraryDirectory) throw new Error('disk full');
    });

    await expect(migrateLegacySettings(context)).rejects.toThrow('disk full');

    expect(vscodeMock.inspected.get('libraryDirectory')).toBe(customLibrary);
    expect(vscodeMock.configurationUpdates).not.toContainEqual({
      key: 'libraryDirectory', value: undefined
    });
  });
});

function createContext(
  initial: Record<string, unknown>,
  beforeUpdate?: (key: string, value: unknown) => Promise<void>
) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    globalStorageUri: { fsPath: path.resolve('D:', 'global-storage') },
    globalState: {
      get<T>(key: string, fallback?: T): T {
        return (values.has(key) ? values.get(key) : fallback) as T;
      },
      async update(key: string, value: unknown): Promise<void> {
        await beforeUpdate?.(key, value);
        if (value === undefined) values.delete(key);
        else values.set(key, value);
      }
    }
  } as never;
}
