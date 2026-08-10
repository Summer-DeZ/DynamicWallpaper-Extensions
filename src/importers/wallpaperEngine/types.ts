import { WallpaperEngineProjectType } from './project';

export type WallpaperEngineImportStage =
  | 'inspect'
  | 'extract'
  | 'convert'
  | 'validate'
  | 'finish';

export interface WallpaperEngineImportProgress {
  stage: WallpaperEngineImportStage;
  message: string;
  increment?: number;
}

export interface WallpaperEngineImportOptions {
  sourceDirectory: string;
  outputDirectory: string;
  extensionPath: string;
  overwrite?: boolean;
  isCancellationRequested?: () => boolean;
  onProgress?: (progress: WallpaperEngineImportProgress) => void;
}

export interface WallpaperEngineImportResult {
  sourceDirectory: string;
  outputDirectory: string;
  projectFile: string;
  reportFile: string;
  sourceType: WallpaperEngineProjectType;
  title: string;
  warnings: string[];
}

export interface ConversionOutcome {
  warnings: string[];
  sceneCompatibility?: string;
}

export interface ExtractedSceneConversionOptions {
  title: string;
  workshopId?: string;
  sceneFile: string;
  extractedDirectory: string;
  outputDirectory: string;
}
