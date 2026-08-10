export const CONFIGURATION_SECTION = 'dynamicWallpaper';
export const PROJECT_FILE_NAME = 'wallpaper.json';

export const STATE_KEYS = {
  activeManagedWallpaperId: 'dynamicWallpaper.activeManagedWallpaperId',
  gpuPreviousValue: 'dynamicWallpaper.gpuPreviousValue',
  gpuExecutable: 'dynamicWallpaper.gpuExecutable',
  workbenchPatchEnabled: 'dynamicWallpaper.workbenchPatchEnabled'
} as const;

export const COMMANDS = {
  selectFolder: 'dynamicWallpaper.selectFolder',
  createProject: 'dynamicWallpaper.createProject',
  importWallpaperEngine: 'dynamicWallpaper.importWallpaperEngine',
  selectImportedWallpaper: 'dynamicWallpaper.selectImportedWallpaper',
  openWallpaperLibrary: 'dynamicWallpaper.openWallpaperLibrary',
  exportImportedWallpaper: 'dynamicWallpaper.exportImportedWallpaper',
  deleteImportedWallpaper: 'dynamicWallpaper.deleteImportedWallpaper',
  apply: 'dynamicWallpaper.apply',
  restore: 'dynamicWallpaper.restore',
  preferHighPerformanceGpu: 'dynamicWallpaper.preferHighPerformanceGpu',
  useSystemGpuPreference: 'dynamicWallpaper.useSystemGpuPreference'
} as const;
