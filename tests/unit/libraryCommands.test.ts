import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: <T>(_key: string, fallback: T): T => fallback
    }))
  },
  window: {
    showQuickPick: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    withProgress: vi.fn()
  },
  commands: {
    executeCommand: vi.fn()
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath })
  },
  ProgressLocation: { Notification: 1 }
}));

const projectCommandsMock = vi.hoisted(() => ({
  applyWallpaper: vi.fn()
}));

vi.mock('vscode', () => vscodeMock);
vi.mock('../../src/application/commands/projectCommands', () => projectCommandsMock);

import { selectImportedWallpaper } from '../../src/application/commands/libraryCommands';
import { STATE_KEYS } from '../../src/application/constants';
import { getWallpaperLibraryDirectory } from '../../src/application/libraryStorage';
import {
  managedWallpaperDirectory,
  upsertManagedWallpaper
} from '../../src/project/wallpaperLibrary';

type Selection =
  | { kind: 'none' }
  | { kind: 'managed'; id: string }
  | { kind: 'external'; directory: string };

let testRoot: string;
let context: ReturnType<typeof createContext>;

beforeEach(async () => {
  vi.clearAllMocks();
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dwr-library-command-test-'));
  context = createContext(testRoot, { kind: 'managed', id: 'wallpaper-a' });
  await addWallpaper('wallpaper-a', 'Zulu Current', 'Scene');
  await addWallpaper('wallpaper-b', 'Alpha Target', 'Web');
  projectCommandsMock.applyWallpaper.mockResolvedValue(true);
});

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true });
});

describe('wallpaper library switching', () => {
  it('puts the current wallpaper first and makes descriptions and details searchable', async () => {
    vscodeMock.window.showQuickPick.mockImplementation(async (
      items: Array<{ entry: { id: string } }>
    ) => items.find(item => item.entry.id === 'wallpaper-b'));
    projectCommandsMock.applyWallpaper.mockImplementation(async appliedContext => {
      expect(readSelection(appliedContext)).toEqual({
        kind: 'managed', id: 'wallpaper-b'
      });
      return true;
    });

    await selectImportedWallpaper(context as never);

    const [items, options] = vscodeMock.window.showQuickPick.mock.calls[0] as [
      Array<{ description?: string; entry: { id: string } }>,
      Record<string, unknown>
    ];
    expect(items.map(item => item.entry.id)).toEqual(['wallpaper-a', 'wallpaper-b']);
    expect(items[0].description).toContain('当前壁纸');
    expect(options).toMatchObject({
      matchOnDescription: true,
      matchOnDetail: true
    });
    expect(readSelection(context)).toEqual({ kind: 'managed', id: 'wallpaper-b' });
    expect(projectCommandsMock.applyWallpaper).toHaveBeenCalledOnce();
    expect(projectCommandsMock.applyWallpaper).toHaveBeenCalledWith(context, true);
    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
    expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('accepts a wallpaper ID directly without opening the picker', async () => {
    await selectImportedWallpaper(context as never, 'wallpaper-b');

    expect(vscodeMock.window.showQuickPick).not.toHaveBeenCalled();
    expect(readSelection(context)).toEqual({ kind: 'managed', id: 'wallpaper-b' });
    expect(projectCommandsMock.applyWallpaper).toHaveBeenCalledWith(context, true);
  });

  it('does not change selection when the QuickPick is cancelled', async () => {
    vscodeMock.window.showQuickPick.mockResolvedValue(undefined);

    await selectImportedWallpaper(context as never);

    expect(readSelection(context)).toEqual({ kind: 'managed', id: 'wallpaper-a' });
    expect(projectCommandsMock.applyWallpaper).not.toHaveBeenCalled();
    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['managed', { kind: 'managed', id: 'wallpaper-a' }],
    ['external', { kind: 'external', directory: path.resolve('D:', 'external-wallpaper') }],
    ['none', { kind: 'none' }]
  ] as const)('restores the previous %s selection when applying fails', async (_name, previous) => {
    context.values.set(STATE_KEYS.projectSelection, previous);
    projectCommandsMock.applyWallpaper.mockResolvedValue(false);

    await selectImportedWallpaper(context as never, 'wallpaper-b');

    expect(projectCommandsMock.applyWallpaper).toHaveBeenCalledWith(context, true);
    expect(readSelection(context)).toEqual(previous);
    expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('validates the target before changing the persisted selection', async () => {
    const projectFile = path.join(
      managedWallpaperDirectory(libraryDirectory(), 'wallpaper-b'),
      'wallpaper.json'
    );
    await fs.writeFile(projectFile, JSON.stringify({ version: 0 }), 'utf8');

    await selectImportedWallpaper(context as never, 'wallpaper-b');

    expect(readSelection(context)).toEqual({ kind: 'managed', id: 'wallpaper-a' });
    expect(projectCommandsMock.applyWallpaper).not.toHaveBeenCalled();
    expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledOnce();
  });

  it('explains how to import when the managed library is empty', async () => {
    const emptyContext = createContext(
      await fs.mkdtemp(path.join(testRoot, 'empty-storage-')),
      { kind: 'none' }
    );

    await selectImportedWallpaper(emptyContext as never);

    expect(vscodeMock.window.showQuickPick).not.toHaveBeenCalled();
    expect(projectCommandsMock.applyWallpaper).not.toHaveBeenCalled();
    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledOnce();
    const [message, ...actions] = vscodeMock.window.showInformationMessage.mock.calls[0] as string[];
    expect(message).toContain('还没有');
    expect(actions).toEqual(expect.arrayContaining([expect.stringMatching(/导入/)]));
  });
});

async function addWallpaper(
  id: string,
  title: string,
  sourceType: 'Scene' | 'Web' | 'Video'
): Promise<void> {
  const root = libraryDirectory();
  await upsertManagedWallpaper(root, {
    id,
    title,
    sourceType,
    sourceDirectory: path.join(testRoot, 'sources', id),
    compatibilityStatus: 'compatible'
  });
  const projectDirectory = managedWallpaperDirectory(root, id);
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.writeFile(path.join(projectDirectory, 'wallpaper.json'), JSON.stringify({
    version: 1,
    layers: [{
      id: 'background',
      type: 'gradient',
      colors: ['#000000', '#ffffff']
    }]
  }), 'utf8');
}

function libraryDirectory(): string {
  return getWallpaperLibraryDirectory(context as never);
}

function createContext(storageRoot: string, initialSelection: Selection) {
  const values = new Map<string, unknown>([
    [STATE_KEYS.projectSelection, initialSelection]
  ]);
  return {
    values,
    extensionPath: testRoot,
    globalStorageUri: { fsPath: storageRoot },
    globalState: {
      get<T>(key: string, fallback?: T): T {
        return (values.has(key) ? values.get(key) : fallback) as T;
      },
      async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) values.delete(key);
        else values.set(key, value);
      }
    }
  };
}

function readSelection(candidate: ReturnType<typeof createContext>): Selection {
  return candidate.values.get(STATE_KEYS.projectSelection) as Selection;
}
