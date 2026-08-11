import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => ({
  env: {
    appRoot: 'C:\\VSCode'
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_key: string, fallback: unknown) => fallback)
    }))
  },
  window: {
    showInformationMessage: vi.fn(),
    showOpenDialog: vi.fn(),
    showWarningMessage: vi.fn(),
    showTextDocument: vi.fn()
  },
  commands: {
    executeCommand: vi.fn()
  }
}));

const settingsMock = vi.hoisted(() => ({
  getProjectDirectory: vi.fn(),
  loadConfiguredWallpaperProject: vi.fn(),
  projectFileFor: vi.fn(),
  selectExternalProject: vi.fn()
}));

const workbenchPatchMock = vi.hoisted(() => ({
  applyWorkbenchPatch: vi.fn(),
  removeWorkbenchPatch: vi.fn()
}));

const gpuCommandsMock = vi.hoisted(() => ({
  setHighPerformanceGpu: vi.fn()
}));

const errorsMock = vi.hoisted(() => ({
  showOperationError: vi.fn()
}));

vi.mock('vscode', () => vscodeMock);
vi.mock('../../src/application/settings', () => settingsMock);
vi.mock('../../src/platform/workbench/workbenchPatch', () => workbenchPatchMock);
vi.mock('../../src/application/commands/gpuCommands', () => gpuCommandsMock);
vi.mock('../../src/application/errors', () => errorsMock);

import { applyWallpaper } from '../../src/application/commands/projectCommands';
import { STATE_KEYS } from '../../src/application/constants';

const projectDirectory = 'D:\\Wallpapers\\selected';
const projectFile = `${projectDirectory}\\wallpaper.json`;
const renderConfiguration = { version: 1, layers: [] };

let context: {
  globalState: {
    update: ReturnType<typeof vi.fn>;
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  context = {
    globalState: {
      update: vi.fn().mockResolvedValue(undefined)
    }
  };
  settingsMock.getProjectDirectory.mockReturnValue(projectDirectory);
  settingsMock.projectFileFor.mockReturnValue(projectFile);
  settingsMock.loadConfiguredWallpaperProject.mockResolvedValue(renderConfiguration);
  workbenchPatchMock.applyWorkbenchPatch.mockResolvedValue(undefined);
  gpuCommandsMock.setHighPerformanceGpu.mockResolvedValue(undefined);
  vscodeMock.commands.executeCommand.mockResolvedValue(undefined);
});

describe('applyWallpaper automatic reload', () => {
  it('applies the Workbench patch, reloads exactly once, and returns true without a second prompt', async () => {
    const result = await applyWallpaper(context as never, true);

    expect(result).toBe(true);
    expect(workbenchPatchMock.applyWorkbenchPatch).toHaveBeenCalledOnce();
    expect(workbenchPatchMock.applyWorkbenchPatch)
      .toHaveBeenCalledWith(vscodeMock.env.appRoot, renderConfiguration);
    expect(context.globalState.update)
      .toHaveBeenCalledWith(STATE_KEYS.workbenchPatchEnabled, true);
    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledOnce();
    expect(vscodeMock.commands.executeCommand)
      .toHaveBeenCalledWith('workbench.action.reloadWindow');
    expect(workbenchPatchMock.applyWorkbenchPatch.mock.invocationCallOrder[0])
      .toBeLessThan(vscodeMock.commands.executeCommand.mock.invocationCallOrder[0]);
    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
    expect(errorsMock.showOperationError).not.toHaveBeenCalled();
  });

  it('returns false and does not reload when applying the core patch fails', async () => {
    const failure = new Error('cannot patch Workbench');
    workbenchPatchMock.applyWorkbenchPatch.mockRejectedValue(failure);

    const result = await applyWallpaper(context as never, true);

    expect(result).toBe(false);
    expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
    expect(context.globalState.update).not.toHaveBeenCalled();
    expect(errorsMock.showOperationError)
      .toHaveBeenCalledWith('应用动态壁纸失败', failure);
  });

  it('keeps the committed result when reload fails and reports the reload error', async () => {
    const failure = new Error('reload command failed');
    vscodeMock.commands.executeCommand.mockRejectedValue(failure);

    const result = await applyWallpaper(context as never, true);

    expect(result).toBe(true);
    expect(workbenchPatchMock.applyWorkbenchPatch).toHaveBeenCalledOnce();
    expect(context.globalState.update)
      .toHaveBeenCalledWith(STATE_KEYS.workbenchPatchEnabled, true);
    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledOnce();
    expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
    expect(errorsMock.showOperationError)
      .toHaveBeenCalledWith('壁纸已应用，但自动重载窗口失败', failure);
  });
});
