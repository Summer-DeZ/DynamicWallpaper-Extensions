export const CONFIGURATION_SECTION = 'dynamicWallpaper';
export const PROJECT_FILE_NAME = 'wallpaper.json';

export const STATE_KEYS = {
  projectSelection: 'dynamicWallpaper.projectSelection',
  activeManagedWallpaperId: 'dynamicWallpaper.activeManagedWallpaperId',
  externalProjectDirectory: 'dynamicWallpaper.externalProjectDirectory',
  wallpaperLibraryDirectory: 'dynamicWallpaper.wallpaperLibraryDirectory',
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
  useSystemGpuPreference: 'dynamicWallpaper.useSystemGpuPreference',
  openRuntimeProperties: 'dynamicWallpaper.openRuntimeProperties',
  openRuntimeDiagnostics: 'dynamicWallpaper.openRuntimeDiagnostics',
  manageRuntimeNetworkAccess: 'dynamicWallpaper.manageRuntimeNetworkAccess'
} as const;
