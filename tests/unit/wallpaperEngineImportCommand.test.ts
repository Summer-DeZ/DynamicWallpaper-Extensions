import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => ({
  window: {
    showOpenDialog: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    withProgress: vi.fn(),
    showTextDocument: vi.fn()
  },
  workspace: {
    openTextDocument: vi.fn()
  },
  commands: {
    executeCommand: vi.fn()
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath })
  },
  ProgressLocation: { Notification: 1 }
}));

const importerMock = vi.hoisted(() => {
  class WallpaperEngineImportError extends Error {
    constructor(message: string, readonly details: string[] = []) {
      super(message);
      this.name = 'WallpaperEngineImportError';
    }
  }

  return {
    importWallpaperEngineProject: vi.fn(),
    readWallpaperEngineProject: vi.fn(),
    WallpaperEngineImportError
  };
});

const filesystemMock = vi.hoisted(() => ({
  pathExists: vi.fn()
}));

const wallpaperLibraryMock = vi.hoisted(() => ({
  createManagedWallpaperId: vi.fn(),
  ensureWallpaperLibrary: vi.fn(),
  managedWallpaperDirectory: vi.fn(),
  upsertManagedWallpaper: vi.fn()
}));

const libraryStorageMock = vi.hoisted(() => ({
  getWallpaperLibraryDirectory: vi.fn()
}));

const settingsMock = vi.hoisted(() => ({
  loadConfiguredWallpaperProject: vi.fn(),
  selectManagedWallpaper: vi.fn()
}));

const libraryCommandsMock = vi.hoisted(() => ({
  selectImportedWallpaper: vi.fn()
}));

vi.mock('vscode', () => vscodeMock);
vi.mock('../../src/importers/wallpaperEngineImporter', () => importerMock);
vi.mock('../../src/platform/filesystem', () => filesystemMock);
vi.mock('../../src/project/wallpaperLibrary', () => wallpaperLibraryMock);
vi.mock('../../src/application/libraryStorage', () => libraryStorageMock);
vi.mock('../../src/application/settings', () => settingsMock);
vi.mock('../../src/application/commands/libraryCommands', () => libraryCommandsMock);

import { importWallpaperEngine } from '../../src/application/commands/wallpaperEngineImportCommand';
import { COMMANDS } from '../../src/application/constants';

const sourceDirectory = 'D:\\WallpaperEngine\\projects\\my-wallpaper';
const libraryDirectory = 'D:\\DynamicWallpaper\\wallpapers';
const outputDirectory = `${libraryDirectory}\\workshop-12345`;
const wallpaperId = 'workshop-12345';
const context = { extensionPath: 'D:\\DynamicWallpaperExtension' };
const output = {
  clear: vi.fn(),
  appendLine: vi.fn(),
  show: vi.fn()
};

beforeEach(() => {
  vi.clearAllMocks();
  vscodeMock.window.showOpenDialog.mockResolvedValue([{ fsPath: sourceDirectory }]);
  vscodeMock.window.showInformationMessage.mockResolvedValue(undefined);
  vscodeMock.window.withProgress.mockImplementation(async (_options, task) => task(
    { report: vi.fn() },
    { isCancellationRequested: false }
  ));
  importerMock.readWallpaperEngineProject.mockResolvedValue({
    file: 'scene.json',
    title: 'My Wallpaper',
    type: 'Scene',
    version: 7,
    workshopid: '12345'
  });
  importerMock.importWallpaperEngineProject.mockResolvedValue({
    sourceDirectory,
    outputDirectory,
    projectFile: `${outputDirectory}\\wallpaper.json`,
    reportFile: `${outputDirectory}\\conversion-report.json`,
    sourceType: 'Scene',
    title: 'My Wallpaper',
    warnings: []
  });
  filesystemMock.pathExists.mockResolvedValue(false);
  wallpaperLibraryMock.createManagedWallpaperId.mockReturnValue(wallpaperId);
  wallpaperLibraryMock.managedWallpaperDirectory.mockReturnValue(outputDirectory);
  libraryStorageMock.getWallpaperLibraryDirectory.mockReturnValue(libraryDirectory);
});

describe('Wallpaper Engine import follow-up actions', () => {
  it('adds the project to the library without replacing the current selection', async () => {
    await importWallpaperEngine(context as never, output as never);

    expect(wallpaperLibraryMock.upsertManagedWallpaper).toHaveBeenCalledOnce();
    expect(settingsMock.selectManagedWallpaper).not.toHaveBeenCalled();
    expect(libraryCommandsMock.selectImportedWallpaper).not.toHaveBeenCalled();
    expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();

    const [message, ...actions] = vscodeMock.window.showInformationMessage.mock.calls[0] as string[];
    expect(message).toContain('导入壁纸库');
    expect(actions).toEqual(expect.arrayContaining(['立即切换', '继续导入']));
  });

  it('switches directly to the newly imported wallpaper when requested', async () => {
    vscodeMock.window.showInformationMessage.mockResolvedValue('立即切换');

    await importWallpaperEngine(context as never, output as never);

    expect(libraryCommandsMock.selectImportedWallpaper)
      .toHaveBeenCalledOnce();
    expect(libraryCommandsMock.selectImportedWallpaper)
      .toHaveBeenCalledWith(context, wallpaperId);
    expect(settingsMock.selectManagedWallpaper).not.toHaveBeenCalled();
    expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('starts another import without switching wallpapers when requested', async () => {
    vscodeMock.window.showInformationMessage.mockResolvedValue('继续导入');

    await importWallpaperEngine(context as never, output as never);

    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledOnce();
    expect(vscodeMock.commands.executeCommand)
      .toHaveBeenCalledWith(COMMANDS.importWallpaperEngine);
    expect(libraryCommandsMock.selectImportedWallpaper).not.toHaveBeenCalled();
    expect(settingsMock.selectManagedWallpaper).not.toHaveBeenCalled();
  });
});
