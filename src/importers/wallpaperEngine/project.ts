import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const PROJECT_FILE_NAME = 'project.json';

export type WallpaperEngineProjectType = 'Scene' | 'Web' | 'Video';

export interface WallpaperEngineProject {
  file: string;
  title: string;
  type: WallpaperEngineProjectType;
  version?: number;
  workshopid?: string;
}

export class WallpaperEngineImportError extends Error {
  constructor(message: string, readonly details: string[] = []) {
    super(message);
    this.name = 'WallpaperEngineImportError';
  }
}

export async function readWallpaperEngineProject(
  sourceDirectory: string
): Promise<WallpaperEngineProject> {
  const projectFile = path.join(path.resolve(sourceDirectory), PROJECT_FILE_NAME);
  let rawText: string;
  try {
    rawText = await fs.readFile(projectFile, 'utf8');
  } catch {
    throw new WallpaperEngineImportError(
      `所选文件夹中没有可读取的 ${PROJECT_FILE_NAME}。`,
      [`期望位置：${projectFile}`]
    );
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(stripBom(rawText)) as Record<string, unknown>;
  } catch (error) {
    throw new WallpaperEngineImportError(
      `${PROJECT_FILE_NAME} 无法解析。`,
      [error instanceof Error ? error.message : String(error)]
    );
  }

  const type = normalizeProjectType(raw.type);
  if (!type) {
    throw new WallpaperEngineImportError(
      `暂不支持 Wallpaper Engine 工程类型“${String(raw.type ?? '未知')}”。`,
      ['当前支持 Web、Video，以及通过兼容性验证的 Scene 工程。']
    );
  }
  if (typeof raw.file !== 'string' || !raw.file.trim()) {
    throw new WallpaperEngineImportError(`${PROJECT_FILE_NAME} 缺少有效的 file 字段。`);
  }

  return {
    file: normalizeRelativeEntry(raw.file),
    title: typeof raw.title === 'string' && raw.title.trim()
      ? raw.title.trim()
      : path.basename(path.resolve(sourceDirectory)),
    type,
    version: typeof raw.version === 'number' ? raw.version : undefined,
    workshopid: typeof raw.workshopid === 'string'
      ? raw.workshopid
      : typeof raw.workshopid === 'number' && Number.isFinite(raw.workshopid)
        ? String(raw.workshopid)
        : undefined
  };
}

function normalizeProjectType(value: unknown): WallpaperEngineProjectType | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (normalized === 'scene') return 'Scene';
  if (normalized === 'web') return 'Web';
  if (normalized === 'video') return 'Video';
  return undefined;
}

function normalizeRelativeEntry(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\/+/, '');
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
