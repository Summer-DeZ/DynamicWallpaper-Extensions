import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { WallpaperEngineProjectType } from '../importers/wallpaperEngine/project';

export const WALLPAPER_LIBRARY_DIRECTORY_NAME = 'wallpapers';
export const WALLPAPER_LIBRARY_INDEX_FILE_NAME = 'library.json';

export interface ManagedWallpaperIdentity {
  title: string;
  workshopId?: string;
}

export interface ManagedWallpaperEntry {
  id: string;
  title: string;
  sourceType: WallpaperEngineProjectType;
  sourceDirectory: string;
  relativeDirectory: string;
  importedAt: string;
  updatedAt: string;
}

export interface WallpaperLibraryCatalog {
  formatVersion: 1;
  updatedAt: string;
  wallpapers: ManagedWallpaperEntry[];
}

export interface ManagedWallpaperEntryInput {
  id: string;
  title: string;
  sourceType: WallpaperEngineProjectType;
  sourceDirectory: string;
  updatedAt?: string;
}

export function createManagedWallpaperId(
  sourceDirectory: string,
  identity: ManagedWallpaperIdentity
): string {
  const workshopId = identity.workshopId?.trim();
  if (workshopId) {
    const safeWorkshopId = workshopId.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (safeWorkshopId) {
      return `workshop-${safeWorkshopId}`;
    }
  }

  const slug = createDirectorySlug(identity.title) || 'wallpaper';
  const normalizedSource = normalizeSourceIdentity(sourceDirectory);
  const sourceHash = createHash('sha256').update(normalizedSource).digest('hex').slice(0, 12);
  return `${slug}-${sourceHash}`;
}

export function managedWallpaperDirectory(libraryDirectory: string, wallpaperId: string): string {
  assertWallpaperId(wallpaperId);
  const libraryRoot = path.resolve(libraryDirectory);
  const projectDirectory = path.resolve(libraryRoot, wallpaperId);
  if (path.dirname(projectDirectory) !== libraryRoot) {
    throw new Error(`壁纸库条目 ID 无效：${wallpaperId}`);
  }
  return projectDirectory;
}

export async function ensureWallpaperLibrary(libraryDirectory: string): Promise<void> {
  await fs.mkdir(path.resolve(libraryDirectory), { recursive: true });
}

export async function readWallpaperLibraryCatalog(
  libraryDirectory: string
): Promise<WallpaperLibraryCatalog> {
  const indexFile = wallpaperLibraryIndexFile(libraryDirectory);
  let rawText: string;
  try {
    rawText = await fs.readFile(indexFile, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return emptyCatalog();
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    throw new Error(`壁纸库索引无法解析：${indexFile}`);
  }
  if (!isRecord(raw) || raw.formatVersion !== 1 || !Array.isArray(raw.wallpapers)) {
    throw new Error(`壁纸库索引格式无效：${indexFile}`);
  }

  const wallpapers = raw.wallpapers.map((entry, index) => parseCatalogEntry(entry, indexFile, index));
  return {
    formatVersion: 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
    wallpapers: wallpapers.sort(compareEntries)
  };
}

export async function listExistingManagedWallpapers(
  libraryDirectory: string
): Promise<ManagedWallpaperEntry[]> {
  const catalog = await readWallpaperLibraryCatalog(libraryDirectory);
  const existing: ManagedWallpaperEntry[] = [];
  for (const entry of catalog.wallpapers) {
    const projectFile = path.join(
      managedWallpaperDirectory(libraryDirectory, entry.id),
      'wallpaper.json'
    );
    try {
      if ((await fs.stat(projectFile)).isFile()) {
        existing.push(entry);
      }
    } catch {
      // A stale catalog entry is hidden until the same source is imported again.
    }
  }
  return existing;
}

export async function upsertManagedWallpaper(
  libraryDirectory: string,
  input: ManagedWallpaperEntryInput
): Promise<ManagedWallpaperEntry> {
  assertWallpaperId(input.id);
  await ensureWallpaperLibrary(libraryDirectory);
  const catalog = await readWallpaperLibraryCatalog(libraryDirectory);
  const existing = catalog.wallpapers.find(entry => entry.id === input.id);
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const entry: ManagedWallpaperEntry = {
    id: input.id,
    title: input.title,
    sourceType: input.sourceType,
    sourceDirectory: path.resolve(input.sourceDirectory),
    relativeDirectory: input.id,
    importedAt: existing?.importedAt ?? updatedAt,
    updatedAt
  };
  const wallpapers = catalog.wallpapers.filter(item => item.id !== input.id);
  wallpapers.push(entry);
  await writeWallpaperLibraryCatalog(libraryDirectory, wallpapers);
  return entry;
}

export async function removeManagedWallpaperFromCatalog(
  libraryDirectory: string,
  wallpaperId: string
): Promise<void> {
  assertWallpaperId(wallpaperId);
  const catalog = await readWallpaperLibraryCatalog(libraryDirectory);
  await writeWallpaperLibraryCatalog(
    libraryDirectory,
    catalog.wallpapers.filter(entry => entry.id !== wallpaperId)
  );
}

function wallpaperLibraryIndexFile(libraryDirectory: string): string {
  return path.join(path.resolve(libraryDirectory), WALLPAPER_LIBRARY_INDEX_FILE_NAME);
}

async function writeWallpaperLibraryCatalog(
  libraryDirectory: string,
  wallpapers: ManagedWallpaperEntry[]
): Promise<void> {
  await ensureWallpaperLibrary(libraryDirectory);
  const updatedAt = new Date().toISOString();
  const catalog: WallpaperLibraryCatalog = {
    formatVersion: 1,
    updatedAt,
    wallpapers: [...wallpapers].sort(compareEntries)
  };
  const indexFile = wallpaperLibraryIndexFile(libraryDirectory);
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temporaryFile = `${indexFile}.${nonce}.tmp`;
  const backupFile = `${indexFile}.${nonce}.backup`;
  let movedExistingIndex = false;
  let installedNewIndex = false;
  await fs.writeFile(temporaryFile, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  try {
    try {
      await fs.rename(indexFile, backupFile);
      movedExistingIndex = true;
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) {
        throw error;
      }
    }
    await fs.rename(temporaryFile, indexFile);
    installedNewIndex = true;
    if (movedExistingIndex) {
      movedExistingIndex = false;
      await fs.rm(backupFile, { force: true }).catch(() => undefined);
    }
  } catch (error) {
    if (movedExistingIndex && !installedNewIndex) {
      await fs.rename(backupFile, indexFile).catch(() => undefined);
      movedExistingIndex = false;
    }
    throw error;
  } finally {
    if (!installedNewIndex) {
      await fs.rm(temporaryFile, { force: true }).catch(() => undefined);
    }
    if (movedExistingIndex) {
      await fs.rm(backupFile, { force: true }).catch(() => undefined);
    }
  }
}

function parseCatalogEntry(
  raw: unknown,
  indexFile: string,
  index: number
): ManagedWallpaperEntry {
  if (!isRecord(raw)
    || typeof raw.id !== 'string'
    || typeof raw.title !== 'string'
    || !isWallpaperEngineProjectType(raw.sourceType)
    || typeof raw.sourceDirectory !== 'string'
    || typeof raw.relativeDirectory !== 'string'
    || typeof raw.importedAt !== 'string'
    || typeof raw.updatedAt !== 'string') {
    throw new Error(`壁纸库索引第 ${index + 1} 个条目无效：${indexFile}`);
  }
  assertWallpaperId(raw.id);
  if (raw.relativeDirectory !== raw.id) {
    throw new Error(`壁纸库索引包含不安全的相对目录：${indexFile}`);
  }
  return {
    id: raw.id,
    title: raw.title,
    sourceType: raw.sourceType,
    sourceDirectory: raw.sourceDirectory,
    relativeDirectory: raw.relativeDirectory,
    importedAt: raw.importedAt,
    updatedAt: raw.updatedAt
  };
}

function assertWallpaperId(wallpaperId: string): void {
  if (!wallpaperId
    || wallpaperId === '.'
    || wallpaperId === '..'
    || path.basename(wallpaperId) !== wallpaperId
    || /[\\/:*?"<>|]/.test(wallpaperId)) {
    throw new Error(`壁纸库条目 ID 无效：${wallpaperId}`);
  }
}

function createDirectorySlug(title: string): string {
  const normalized = title
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return Array.from(normalized).slice(0, 48).join('').replace(/-+$/g, '');
}

function normalizeSourceIdentity(sourceDirectory: string): string {
  const normalized = path.resolve(sourceDirectory).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function compareEntries(left: ManagedWallpaperEntry, right: ManagedWallpaperEntry): number {
  return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
}

function emptyCatalog(): WallpaperLibraryCatalog {
  return {
    formatVersion: 1,
    updatedAt: new Date(0).toISOString(),
    wallpapers: []
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWallpaperEngineProjectType(value: unknown): value is WallpaperEngineProjectType {
  return value === 'Scene' || value === 'Web' || value === 'Video';
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
