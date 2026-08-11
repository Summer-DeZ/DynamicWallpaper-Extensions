import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { WallpaperEngineProjectType } from '../importers/wallpaperEngine/project';

export const WALLPAPER_LIBRARY_DIRECTORY_NAME = 'wallpapers';
export const WALLPAPER_LIBRARY_INDEX_FILE_NAME = 'library.json';
const WALLPAPER_LIBRARY_BACKUP_FILE_NAME = `${WALLPAPER_LIBRARY_INDEX_FILE_NAME}.backup`;
const WALLPAPER_LIBRARY_LOCK_FILE_NAME = '.library.lock';
const LOCK_STALE_AFTER_MS = 15_000;
const LOCK_WAIT_TIMEOUT_MS = 20_000;
const IMPORT_BACKUP_STALE_AFTER_MS = 5_000;
const libraryOperationQueues = new Map<string, Promise<void>>();

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
  runtimeFormatVersion: number;
  sourceVersion?: number;
  compatibilityStatus: 'compatible' | 'partial' | 'incompatible' | 'legacy';
  networkHosts: string[];
}

export interface WallpaperLibraryCatalog {
  formatVersion: 2;
  updatedAt: string;
  wallpapers: ManagedWallpaperEntry[];
}

export interface ManagedWallpaperEntryInput {
  id: string;
  title: string;
  sourceType: WallpaperEngineProjectType;
  sourceDirectory: string;
  updatedAt?: string;
  runtimeFormatVersion?: number;
  sourceVersion?: number;
  compatibilityStatus?: ManagedWallpaperEntry['compatibilityStatus'];
  networkHosts?: string[];
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
  return withLibraryLock(
    libraryDirectory,
    () => readWallpaperLibraryCatalogUnlocked(libraryDirectory)
  );
}

async function readWallpaperLibraryCatalogUnlocked(
  libraryDirectory: string
): Promise<WallpaperLibraryCatalog> {
  const indexFile = wallpaperLibraryIndexFile(libraryDirectory);
  const backupFile = path.join(path.resolve(libraryDirectory), WALLPAPER_LIBRARY_BACKUP_FILE_NAME);
  let primaryError: unknown;
  try {
    return parseWallpaperLibraryCatalog(await fs.readFile(indexFile, 'utf8'), indexFile);
  } catch (error) {
    primaryError = error;
  }

  try {
    const recovered = parseWallpaperLibraryCatalog(
      await fs.readFile(backupFile, 'utf8'),
      backupFile
    );
    await fs.copyFile(backupFile, indexFile);
    await fs.rm(backupFile, { force: true }).catch(() => undefined);
    return recovered;
  } catch (backupError) {
    if (isNodeError(primaryError, 'ENOENT') && isNodeError(backupError, 'ENOENT')) {
      return emptyCatalog();
    }
    throw primaryError;
  }
}

function parseWallpaperLibraryCatalog(
  rawText: string,
  indexFile: string
): WallpaperLibraryCatalog {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    throw new Error(`壁纸库索引无法解析：${indexFile}`);
  }
  if (!isRecord(raw) || (raw.formatVersion !== 1 && raw.formatVersion !== 2) || !Array.isArray(raw.wallpapers)) {
    throw new Error(`壁纸库索引格式无效：${indexFile}`);
  }

  const wallpapers = raw.wallpapers.map((entry, index) => parseCatalogEntry(entry, indexFile, index));
  return {
    formatVersion: 2,
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
    await recoverInterruptedManagedWallpaper(libraryDirectory, entry.id);
    const projectFile = path.join(
      managedWallpaperDirectory(libraryDirectory, entry.id),
      'wallpaper.json'
    );
    try {
      if ((await fs.stat(projectFile)).isFile()) {
        existing.push(entry);
      }
    } catch (error) {
      if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTDIR')) throw error;
      // A genuinely missing catalog entry is hidden until the same source is imported again.
    }
  }
  return existing;
}

async function recoverInterruptedManagedWallpaper(
  libraryDirectory: string,
  wallpaperId: string
): Promise<void> {
  const projectDirectory = managedWallpaperDirectory(libraryDirectory, wallpaperId);
  if (await fs.stat(projectDirectory).then(stat => stat.isDirectory(), () => false)) return;
  const backupPrefix = `.${wallpaperId}.backup-`;
  const candidates = await fs.readdir(path.resolve(libraryDirectory), { withFileTypes: true })
    .then(entries => entries.filter(entry => entry.isDirectory() && entry.name.startsWith(backupPrefix)))
    .catch(error => {
      if (isNodeError(error, 'ENOENT')) return [];
      throw error;
    });
  const recoverable = (await Promise.all(candidates.map(async entry => {
    const directory = path.join(path.resolve(libraryDirectory), entry.name);
    const projectFile = path.join(directory, 'wallpaper.json');
    const stats = await fs.stat(projectFile).catch(() => undefined);
    const backupTimestamp = Number.parseInt(
      entry.name.slice(backupPrefix.length).match(/^\d+-(\d+)/)?.[1] ?? '',
      10
    );
    return stats?.isFile()
      && Number.isFinite(backupTimestamp)
      && Date.now() - backupTimestamp >= IMPORT_BACKUP_STALE_AFTER_MS
      ? { directory, modified: backupTimestamp }
      : undefined;
  }))).filter((value): value is { directory: string; modified: number } => value !== undefined)
    .sort((left, right) => right.modified - left.modified);
  for (const candidate of recoverable) {
    try {
      await fs.rename(candidate.directory, projectDirectory);
      return;
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) return;
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
  }
}

export async function upsertManagedWallpaper(
  libraryDirectory: string,
  input: ManagedWallpaperEntryInput
): Promise<ManagedWallpaperEntry> {
  assertWallpaperId(input.id);
  return withLibraryLock(libraryDirectory, async () => {
    const catalog = await readWallpaperLibraryCatalogUnlocked(libraryDirectory);
    const existing = catalog.wallpapers.find(entry => entry.id === input.id);
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const entry: ManagedWallpaperEntry = {
      id: input.id,
      title: input.title,
      sourceType: input.sourceType,
      sourceDirectory: path.resolve(input.sourceDirectory),
      relativeDirectory: input.id,
      importedAt: existing?.importedAt ?? updatedAt,
      updatedAt,
      runtimeFormatVersion: input.runtimeFormatVersion ?? existing?.runtimeFormatVersion ?? 1,
      sourceVersion: input.sourceVersion ?? existing?.sourceVersion,
      compatibilityStatus: input.compatibilityStatus ?? existing?.compatibilityStatus ?? 'legacy',
      networkHosts: input.networkHosts ?? existing?.networkHosts ?? []
    };
    const wallpapers = catalog.wallpapers.filter(item => item.id !== input.id);
    wallpapers.push(entry);
    await writeWallpaperLibraryCatalogUnlocked(libraryDirectory, wallpapers);
    return entry;
  });
}

export async function removeManagedWallpaperFromCatalog(
  libraryDirectory: string,
  wallpaperId: string
): Promise<void> {
  assertWallpaperId(wallpaperId);
  await withLibraryLock(libraryDirectory, async () => {
    const catalog = await readWallpaperLibraryCatalogUnlocked(libraryDirectory);
    await writeWallpaperLibraryCatalogUnlocked(
      libraryDirectory,
      catalog.wallpapers.filter(entry => entry.id !== wallpaperId)
    );
  });
}

function wallpaperLibraryIndexFile(libraryDirectory: string): string {
  return path.join(path.resolve(libraryDirectory), WALLPAPER_LIBRARY_INDEX_FILE_NAME);
}

async function writeWallpaperLibraryCatalogUnlocked(
  libraryDirectory: string,
  wallpapers: ManagedWallpaperEntry[]
): Promise<void> {
  await ensureWallpaperLibrary(libraryDirectory);
  const updatedAt = new Date().toISOString();
  const catalog: WallpaperLibraryCatalog = {
    formatVersion: 2,
    updatedAt,
    wallpapers: [...wallpapers].sort(compareEntries)
  };
  const indexFile = wallpaperLibraryIndexFile(libraryDirectory);
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temporaryFile = `${indexFile}.${nonce}.tmp`;
  const backupFile = path.join(path.resolve(libraryDirectory), WALLPAPER_LIBRARY_BACKUP_FILE_NAME);
  let backedUpExistingIndex = false;
  let installedNewIndex = false;
  const temporaryHandle = await fs.open(temporaryFile, 'wx');
  try {
    await temporaryHandle.writeFile(`${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
    await temporaryHandle.sync();
  } finally {
    await temporaryHandle.close();
  }
  try {
    try {
      await fs.copyFile(indexFile, backupFile);
      backedUpExistingIndex = true;
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) {
        throw error;
      }
    }
    // Windows cannot rename over an existing file. Readers share the lock,
    // while the durable backup makes this replacement window crash-safe.
    await fs.rm(indexFile, { force: true });
    await fs.rename(temporaryFile, indexFile);
    installedNewIndex = true;
    await fs.rm(backupFile, { force: true }).catch(() => undefined);
    backedUpExistingIndex = false;
  } catch (error) {
    if (backedUpExistingIndex && !installedNewIndex) {
      await fs.copyFile(backupFile, indexFile).catch(() => undefined);
    }
    throw error;
  } finally {
    if (!installedNewIndex) {
      await fs.rm(temporaryFile, { force: true }).catch(() => undefined);
    }
    if (installedNewIndex) await fs.rm(backupFile, { force: true }).catch(() => undefined);
  }
}

async function withLibraryLock<T>(
  libraryDirectory: string,
  operation: () => Promise<T>
): Promise<T> {
  const libraryRoot = path.resolve(libraryDirectory);
  const previous = libraryOperationQueues.get(libraryRoot) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const releaseFileLock = await acquireLibraryFileLock(libraryRoot);
    try {
      return await operation();
    } finally {
      await releaseFileLock();
    }
  });
  const tail = current.then(() => undefined, () => undefined);
  libraryOperationQueues.set(libraryRoot, tail);
  try {
    return await current;
  } finally {
    if (libraryOperationQueues.get(libraryRoot) === tail) {
      libraryOperationQueues.delete(libraryRoot);
    }
  }
}

async function acquireLibraryFileLock(libraryRoot: string): Promise<() => Promise<void>> {
  await ensureWallpaperLibrary(libraryRoot);
  const lockFile = path.join(libraryRoot, WALLPAPER_LIBRARY_LOCK_FILE_NAME);
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  let delayMs = 10;
  for (;;) {
    try {
      const handle = await fs.open(lockFile, 'wx');
      try {
        await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, 'utf8');
      } catch (error) {
        await handle.close().catch(() => undefined);
        await fs.rm(lockFile, { force: true }).catch(() => undefined);
        throw error;
      }
      return async () => {
        await handle.close().catch(() => undefined);
        await fs.rm(lockFile, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
      const lockStat = await fs.stat(lockFile).catch(() => undefined);
      const lockOwner = Number.parseInt(
        await fs.readFile(lockFile, 'utf8').catch(() => ''),
        10
      );
      if ((Number.isInteger(lockOwner) && !isProcessAlive(lockOwner))
        || (lockStat && Date.now() - lockStat.mtimeMs >= LOCK_STALE_AFTER_MS)) {
        await fs.rm(lockFile, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`等待壁纸库锁超时：${lockFile}`);
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
      delayMs = Math.min(100, delayMs * 2);
    }
  }
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, 'ESRCH');
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
    updatedAt: raw.updatedAt,
    runtimeFormatVersion: typeof raw.runtimeFormatVersion === 'number' ? raw.runtimeFormatVersion : 0,
    sourceVersion: typeof raw.sourceVersion === 'number' ? raw.sourceVersion : undefined,
    compatibilityStatus: isCompatibilityStatus(raw.compatibilityStatus) ? raw.compatibilityStatus : 'legacy',
    networkHosts: Array.isArray(raw.networkHosts)
      ? raw.networkHosts.filter((host): host is string => typeof host === 'string')
      : []
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
    formatVersion: 2,
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

function isCompatibilityStatus(value: unknown): value is ManagedWallpaperEntry['compatibilityStatus'] {
  return value === 'compatible' || value === 'partial' || value === 'incompatible' || value === 'legacy';
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
